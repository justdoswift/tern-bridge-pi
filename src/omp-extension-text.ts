import { Text } from '@oh-my-pi/pi-tui/components/text';
import { node } from '@oh-my-pi/pi-tui/native/describe';
import type { DescribeContext, NativeNode } from '@oh-my-pi/pi-tui/native/node';

/** Keep extension text in the composer's HUD column, retaining its ANSI spans. */
export class PiExtensionText extends Text {
  private source: NativeNode | undefined;
  private native: NativeNode | undefined;

  override describe(cx: DescribeContext): NativeNode {
    const source = super.describe(cx);
    if (source !== this.source) {
      this.source = source;
      this.native = node('col', { role: 'omp.hud.status' }, [
        node('col', { role: 'pi.extension.text' }, [source]),
      ]);
    }
    return this.native!;
  }
}
