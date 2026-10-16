import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageContent } from '@oh-my-pi/pi-ai';
import { readImageFromClipboard, readTextFromClipboard, type ClipboardImage } from '@oh-my-pi/pi-natives/clipboard';
import { parseImageMetadata } from '@oh-my-pi/pi-utils/mime';
import { imageDecodeFailureReason, MAX_IMAGE_INPUT_BYTES } from '@oh-my-pi/pi-tui/chat/image-loading';
import { chipLabel, compactImageMarkers, formatVisionMarker, PLACEHOLDER_REGEX } from '@oh-my-pi/pi-tui/prompt/composer-attachments';
import { extractImagePastePathsFromText, extractImagePathFromText, type CustomEditor } from '@oh-my-pi/pi-tui/prompt/custom-editor';
import { cachedImageDimensions, setCachedImageDimensions } from '@oh-my-pi/pi-tui/prompt/image-references';
import { tagImageAttachmentSource } from '@oh-my-pi/pi-tui/prompt/image-source';
import type { InputImage, Locale } from './contracts.js';
import { dictionary } from './i18n.js';

export interface ImageSubmission {
  readonly text: string;
  readonly images: readonly InputImage[];
}

export interface ImageSessionChange {
  complete(): void;
  rollback(): void;
}

export interface PiImageComposerOptions {
  locale(): Locale;
  currentSession(): string | null;
  cwd(): string;
  onChange(): void;
  onError(error: Error): void;
  onSubmit(submission: ImageSubmission): void;
}

type ImageErrorKey = 'imagePathInvalid' | 'imageInvalid' | 'imageTooLarge' | 'imageClipboardFailed';
class AttachmentError extends Error {
  constructor(readonly key: ImageErrorKey) { super(key); }
}
interface TransitionLifetime { active: boolean; session: string | null; cwd: string }
interface Lifetime {
  readonly generation: number;
  readonly session: string | null;
  readonly cwd: string;
  readonly transition?: TransitionLifetime;
}
interface SubmissionState extends Lifetime {
  readonly revision: number;
  readonly atomsRevision: number;
  readonly images: readonly ImageContent[];
  readonly historyText: string;
  staged?: { revision: number; atomsRevision: number };
}

/** Native omp chips and paste serialization, with Pi's acceptance boundary. */
export class PiImageComposer {
  readonly #submissions = new WeakMap<ImageSubmission, SubmissionState>();
  readonly #inputLifetime = new AsyncLocalStorage<Lifetime>();
  readonly #originalHandleInput: CustomEditor['handleInput'];
  readonly #originalHandleDraftEdit: CustomEditor['handleDraftEdit'];
  readonly #originalChange: CustomEditor['onChange'];
  readonly #originalSubmit: CustomEditor['onSubmit'];
  readonly #originalPasteImage: CustomEditor['onPasteImage'];
  readonly #originalPastePath: CustomEditor['onPasteImagePath'];
  readonly #originalClearPasteState: CustomEditor['clearPasteState'];
  #rawDraft: string;
  #restoringDraft: string | undefined;
  #generation = 0;
  #disposed = false;
  #transition: TransitionLifetime | undefined;
  #pendingAttachments = 0;

  constructor(readonly editor: CustomEditor, readonly options: PiImageComposerOptions) {
    this.#rawDraft = editor.getText();
    this.#originalChange = editor.onChange;
    this.#originalSubmit = editor.onSubmit;
    this.#originalPasteImage = editor.onPasteImage;
    this.#originalPastePath = editor.onPasteImagePath;
    this.#originalClearPasteState = editor.clearPasteState;
    this.#originalHandleInput = editor.handleInput;
    this.#originalHandleDraftEdit = editor.handleDraftEdit;
    editor.handleInput = this.#handleInput;
    editor.handleDraftEdit = this.#handleDraftEdit;
    editor.clearPasteState = this.#clearPasteState;
    editor.onChange = this.#change;
    editor.onSubmit = this.#submit;
    editor.onPasteImage = this.#pasteImage;
    editor.onPasteImagePath = this.#pastePath;
  }

  #lifetime(): Lifetime {
    return { generation: this.#generation, session: this.options.currentSession(), cwd: this.options.cwd(), transition: this.#transition };
  }
  #alive(lifetime: Lifetime): boolean {
    const transition = lifetime.transition;
    return !this.#disposed && lifetime.generation === this.#generation &&
      (transition?.active || (
        (transition ? transition.session : lifetime.session) === this.options.currentSession() &&
        (transition ? transition.cwd : lifetime.cwd) === this.options.cwd()
      ));
  }
  #report(error: unknown, fallback: ImageErrorKey): void {
    this.options.onError(new Error(dictionary(this.options.locale())[error instanceof AttachmentError ? error.key : fallback]));
  }

  // Editor.#submitValue empties its buffer, calls this public hook, then emits
  // onChange/onSubmit. Defer only that clearing so the original private paste
  // table and atom expansions survive; rebuilding from expanded text loses chips.
  readonly #clearPasteState = (): void => {
    if (!this.#disposed && this.#rawDraft !== '' && this.editor.getText() === '') {
      this.#restoringDraft = this.#rawDraft;
      return;
    }
    this.#originalClearPasteState.call(this.editor);
  };
  readonly #change = (text: string): void => {
    if (this.#restoringDraft !== undefined && text === '') return;
    this.#rawDraft = text;
    this.#originalChange?.(text);
    this.options.onChange();
  };
  readonly #submit = (text: string): void => {
    const submission = this.captureSubmission(text);
    this.options.onSubmit(submission);
  };
  // The native multi-path router awaits each load before calling the next hook.
  // Its complete async chain must retain the originating session, not re-sample
  // the newly opened session halfway through a dropped group of files.
  readonly #handleInput = (data: string): void => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleInput.call(this.editor, data));
  };
  readonly #handleDraftEdit = (data: string): void => {
    this.#inputLifetime.run(this.#lifetime(), () => this.#originalHandleDraftEdit.call(this.editor, data));
  };
  readonly #pastePath = (path: string): Promise<void> =>
    this.#loadPath(path, this.#inputLifetime.getStore() ?? this.#lifetime());
  readonly #pasteImage = (): Promise<boolean> => this.pasteClipboard();

  /** Called synchronously from omp's onSubmit; restores the untouched chip draft. */
  captureSubmission(message: string): ImageSubmission {
    const rawDraft = this.#restoringDraft;
    this.#restoringDraft = undefined;
    if (rawDraft !== undefined) this.editor.setText(rawDraft);
    const compacted = compactImageMarkers(message, this.editor.pendingImages.length, { byAppearance: true });
    const retained = compacted ? compacted.keep.map(index => this.editor.pendingImages[index]) : this.editor.pendingImages;
    const expanded = compacted?.text ?? message;
    // Chip markers are presentation metadata, not invented prose for Pi.
    const text = expanded.replace(PLACEHOLDER_REGEX, (marker: string, kind: string, index: string) =>
      kind === 'Image' && Number(index) <= retained.length ? '' : marker).trim();
    const images: readonly InputImage[] = Object.freeze(retained.map(image => {
      if (!image || !isInputMime(image.mimeType)) throw new AttachmentError('imageInvalid');
      return Object.freeze({ data: image.data, mimeType: image.mimeType });
    }));
    const submission: ImageSubmission = Object.freeze({ text, images });
    this.#submissions.set(submission, {
      ...this.#lifetime(), revision: this.editor.textRevision, atomsRevision: this.editor.atomsRevision,
      images: [...this.editor.pendingImages], historyText: this.editor.getExpandedText(),
    });
    return submission;
  }

  /** Clear immediately, retaining the complete native draft in local ↑ navigation. */
  stage(submission: ImageSubmission): boolean {
    const state = this.#submissions.get(submission);
    if (!state || state.staged || !this.#alive(state) ||
      state.revision !== this.editor.textRevision || state.atomsRevision !== this.editor.atomsRevision) return false;
    this.editor.clearDraftForRecall();
    state.staged = { revision: this.editor.textRevision, atomsRevision: this.editor.atomsRevision };
    this.options.onChange();
    return true;
  }

  /** Restore only an untouched composer; newer input keeps the original in local recall. */
  restore(submission: ImageSubmission): boolean {
    const state = this.#submissions.get(submission);
    this.#submissions.delete(submission);
    if (!state?.staged || !this.#alive(state) || this.#pendingAttachments !== 0 ||
      state.staged.revision !== this.editor.textRevision || state.staged.atomsRevision !== this.editor.atomsRevision) return false;
    this.editor.setDraft(state.historyText, state.images);
    this.options.onChange();
    return true;
  }

  /** Acceptance commits this submission, never clearing a newer draft. */
  accept(submission: ImageSubmission): boolean {
    const state = this.#submissions.get(submission);
    this.#submissions.delete(submission);
    if (!state || !this.#alive(state)) return false;
    if (state.staged) return true;
    if (state.revision !== this.editor.textRevision ||
      state.atomsRevision !== this.editor.atomsRevision || state.images.length !== this.editor.pendingImages.length ||
      state.images.some((image, index) => image !== this.editor.pendingImages[index])) {
      this.editor.addToHistory(state.historyText);
      return false;
    }
    this.editor.clearDraft(state.historyText);
    this.options.onChange();
    return true;
  }

  hasAttachments(): boolean { return this.editor.composerChips().some(chip => chip.kind === 'image'); }

  /** Detach the old draft while a session opens, without destroying native paste tables. */
  beginSessionChange(): ImageSessionChange {
    let previous: {
      text: string; images: CustomEditor['pendingImages']; links: CustomEditor['pendingImageLinks'];
      imageLinks: CustomEditor['imageLinks']; texts: CustomEditor['pendingTexts'];
    } | undefined = {
      text: this.editor.getText(), images: this.editor.pendingImages, links: this.editor.pendingImageLinks,
      imageLinks: this.editor.imageLinks, texts: this.editor.pendingTexts,
    };
    const generation = ++this.#generation;
    this.#pendingAttachments = 0;
    this.#restoringDraft = undefined;
    const transition: TransitionLifetime = {
      active: true, session: this.options.currentSession(), cwd: this.options.cwd(),
    };
    this.#transition = transition;
    this.editor.pendingImages = [];
    this.editor.pendingImageLinks = [];
    this.editor.imageLinks = undefined;
    this.editor.pendingTexts = [];
    // setText intentionally leaves the original private paste/atom table alone.
    this.editor.setText('');
    const revision = this.editor.textRevision;
    const atomsRevision = this.editor.atomsRevision;
    let settled = false;
    const finish = (restore: boolean): void => {
      if (settled) return;
      settled = true;
      transition.active = false;
      transition.session = this.options.currentSession();
      transition.cwd = this.options.cwd();
      if (this.#transition === transition) this.#transition = undefined;
      if (!this.#disposed && generation === this.#generation) {
        const unchanged = revision === this.editor.textRevision && atomsRevision === this.editor.atomsRevision &&
          this.#pendingAttachments === 0;
        if (restore && unchanged && previous) {
          this.editor.pendingImages = previous.images;
          this.editor.pendingImageLinks = previous.links;
          this.editor.imageLinks = previous.imageLinks;
          this.editor.pendingTexts = previous.texts;
          this.editor.setText(previous.text);
        } else if (unchanged) {
          this.#originalClearPasteState.call(this.editor);
        }
        this.options.onChange();
      }
      previous = undefined;
    };
    return { complete: () => finish(false), rollback: () => finish(true) };
  }

  /** Call only after a session change succeeds; also fences work from the old session. */
  resetSession(): void {
    this.#generation++;
    this.#transition = undefined;
    this.#pendingAttachments = 0;
    this.#restoringDraft = undefined;
    this.editor.clearDraft();
    this.options.onChange();
  }

  async #loadPath(path: string, lifetime: Lifetime): Promise<void> {
    if (!this.#alive(lifetime)) return;
    this.#pendingAttachments++;
    try {
      const extracted = extractImagePathFromText(path) ?? path.trim();
      const normalized = extracted.length > 1 && (extracted[0] === '"' || extracted[0] === "'") && extracted.at(-1) === extracted[0]
        ? extracted.slice(1, -1) : extracted;
      const localPath = normalized.startsWith('file:') ? fileURLToPath(normalized) : normalized;
      if (!localPath || localPath.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(localPath)) throw new AttachmentError('imagePathInvalid');
      const fullPath = resolve(lifetime.cwd, localPath.startsWith('~/') ? resolve(homedir(), localPath.slice(2)) : localPath);
      // Nonblocking open lets us reject FIFOs/devices without waiting for a writer.
      const file = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) throw new AttachmentError('imagePathInvalid');
        if (stat.size > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError('imageTooLarge');
        bytes = await file.readFile();
      } finally { await file.close(); }
      if (bytes.length > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError('imageTooLarge');
      if (!this.#alive(lifetime)) return;
      const image = await decodedImage(bytes, fullPath);
      if (!this.#alive(lifetime)) return;
      this.#attach(image, fullPath);
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, 'imagePathInvalid');
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }

  /** Invoked only by an explicit native paste action, never at startup. */
  async pasteClipboard(): Promise<boolean> {
    const lifetime = this.#inputLifetime.getStore() ?? this.#lifetime();
    if (!this.#alive(lifetime)) return false;
    this.#pendingAttachments++;
    try {
      let text: string | null | undefined;
      let textFailed = false;
      try { text = await readTextFromClipboard(); } catch { textFailed = true; }
      if (!this.#alive(lifetime)) return false;
      const paths = text ? extractImagePastePathsFromText(text) : undefined;
      if (paths?.length) {
        for (const path of paths) {
          if (!this.#alive(lifetime)) return false;
          await this.#loadPath(path, lifetime);
        }
        return true;
      }
      let imageFailed = false;
      let clipboard: ClipboardImage | null | undefined;
      try { clipboard = await readImageFromClipboard(); } catch { imageFailed = true; }
      if (!this.#alive(lifetime)) return false;
      if (clipboard) {
        const image = await decodedImage(clipboard.data);
        if (!this.#alive(lifetime)) return false;
        this.#attach(image);
        return true;
      }
      if (text) {
        this.editor.pasteText(text);
        this.options.onChange();
        return true;
      }
      if (textFailed || imageFailed) throw new AttachmentError('imageClipboardFailed');
      return false;
    } catch (error) {
      if (this.#alive(lifetime)) this.#report(error, 'imageClipboardFailed');
      return false;
    } finally {
      if (lifetime.generation === this.#generation) this.#pendingAttachments--;
    }
  }

  #attach(image: ImageContent, path?: string): void {
    const dims = cachedImageDimensions(image) ?? undefined;
    this.editor.pendingImages.push(image);
    this.editor.pendingImageLinks.push(path);
    this.editor.imageLinks = this.editor.pendingImageLinks;
    const n = this.editor.pendingImages.length;
    this.editor.insertAtom(chipLabel('image', n), formatVisionMarker('image', n, dims));
    this.options.onChange();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    if (this.editor.clearPasteState === this.#clearPasteState) this.editor.clearPasteState = this.#originalClearPasteState;
    if (this.editor.onChange === this.#change) this.editor.onChange = this.#originalChange;
    if (this.editor.onSubmit === this.#submit) this.editor.onSubmit = this.#originalSubmit;
    if (this.editor.onPasteImage === this.#pasteImage) this.editor.onPasteImage = this.#originalPasteImage;
    if (this.editor.onPasteImagePath === this.#pastePath) this.editor.onPasteImagePath = this.#originalPastePath;
    if (this.editor.handleInput === this.#handleInput) this.editor.handleInput = this.#originalHandleInput;
    if (this.editor.handleDraftEdit === this.#handleDraftEdit) this.editor.handleDraftEdit = this.#originalHandleDraftEdit;
    // A keyboard submission can dispose us inside run(); Bun 1.3.14 must first unwind it.
    queueMicrotask(() => this.#inputLifetime.disable());
    this.editor.clearDraft();
  }
}

function isInputMime(mimeType: string): mimeType is InputImage['mimeType'] {
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/gif' || mimeType === 'image/webp';
}
async function decodedImage(bytes: Uint8Array, path?: string): Promise<ImageContent> {
  if (bytes.byteLength > MAX_IMAGE_INPUT_BYTES) throw new AttachmentError('imageTooLarge');
  const metadata = parseImageMetadata(bytes);
  if (!metadata || !isInputMime(metadata.mimeType)) throw new AttachmentError('imageInvalid');
  const image: ImageContent = {
    type: 'image', data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), mimeType: metadata.mimeType,
  };
  if (await imageDecodeFailureReason(image) !== null) throw new AttachmentError('imageInvalid');
  const attached = path ? tagImageAttachmentSource(image, path, 'image') : image;
  setCachedImageDimensions(attached, metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : null);
  return attached;
}

/** Localize only the backend's explicit image-admission errors; preserve other errors. */
export function imageAdmissionError(error: unknown, locale: Locale): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const labels = dictionary(locale);
  switch (message) {
    case 'The selected Pi model does not support image attachments. Choose an image-capable model or remove the images.':
      return labels.imageUnsupportedModel;
    case 'Image attachments must contain valid base64 data in JPEG, PNG, GIF or WebP format.':
      return labels.imageInvalid;
    case 'Enter a message or attach an image before sending.':
      return labels.imageEmptyDraft;
    default:
      return undefined;
  }
}
