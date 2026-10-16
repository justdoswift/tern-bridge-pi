--!strict

type Preferences = { bunPath: string?, piPath: string?, locale: string? }

local function preferences(): Preferences
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(tern.plugin.data .. "/preferences.json"))
	end)
	if not ok or type(value) ~= "table" then return {} end
	return {
		bunPath = if type(value.bunPath) == "string" and value.bunPath ~= "" then value.bunPath else nil,
		piPath = if type(value.piPath) == "string" and value.piPath ~= "" then value.piPath else nil,
		locale = if value.locale == "en-US" then "en-US" else "zh-CN",
	}
end

-- New local zsh panes only. Keep every other plugin's spawn fields and chain its
-- ZDOTDIR rather than replacing its startup behavior (including the Droid bridge).
tern.on("spawn", function(spec: SpawnSpec): SpawnSpec?
	if tern.runtime.os ~= "macos" and tern.runtime.os ~= "linux" then return nil end
	if string.match(spec.program, "([^/]+)$") ~= "zsh" then return nil end
	local current = preferences()
	spec.env.TERN_PI_BRIDGE_DIR = tern.plugin.dir
	spec.env.TERN_PI_BRIDGE_DATA = tern.plugin.data
	spec.env.TERN_PI_BRIDGE_BUN = current.bunPath or "bun"
	spec.env.TERN_PI_BRIDGE_PI = current.piPath or "pi"
	spec.env.TERN_PI_BRIDGE_LOCALE = current.locale or "zh-CN"
	local zdotdir = spec.env.ZDOTDIR or tern.getenv("ZDOTDIR")
	spec.env.TERN_PI_BRIDGE_ZDOTDIR = zdotdir or ""
	spec.env.TERN_PI_BRIDGE_ZDOTDIR_SET = if zdotdir == nil then "0" else "1"
	spec.env.ZDOTDIR = tern.plugin.dir .. "/shell/zsh"
	return spec
end)
