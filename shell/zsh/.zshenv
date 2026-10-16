# Tern chains the ZDOTDIR supplied by the spawn hook through its own integration.
# Restore the original directory (possibly another plugin) before sourcing it.
if [[ "${TERN_PI_BRIDGE_ZDOTDIR_SET-0}" == 1 ]]; then
	'builtin' 'export' ZDOTDIR="$TERN_PI_BRIDGE_ZDOTDIR"
else
	'builtin' 'unset' 'ZDOTDIR'
fi
'builtin' 'unset' 'TERN_PI_BRIDGE_ZDOTDIR' 'TERN_PI_BRIDGE_ZDOTDIR_SET'
'builtin' 'typeset' _tern_pi_bridge_zshenv=${ZDOTDIR-~}"/.zshenv"
if [[ -r "$_tern_pi_bridge_zshenv" && ! "$_tern_pi_bridge_zshenv" -ef "${(%):-%x}" ]]; then
	'builtin' 'source' '--' "$_tern_pi_bridge_zshenv"
fi
'builtin' 'unset' '_tern_pi_bridge_zshenv'

# Bind after the author's profiles, without overriding an existing alias/function
# or modifying PATH. `command pi` keeps the ordinary official CLI behavior.
if [[ -o interactive ]]; then
	_tern_pi_bridge_ready() {
		'builtin' 'local' name canonical=${commands[pi]-}
		for name in {p,P}{i,I}; do
			(( $+aliases[$name] || $+functions[$name] )) && continue
			# Preserve unrelated case-sensitive executables as well as user bindings.
			if [[ "$name" != pi ]] && (( $+commands[$name] )) && [[ ! "${commands[$name]}" -ef "$canonical" ]]; then
				continue
			fi
			functions[$name]='"$TERN_PI_BRIDGE_DIR/bin/pi" "$@"'
		done
		precmd_functions=("${(@)precmd_functions:#_tern_pi_bridge_ready}")
		'builtin' 'unfunction' '_tern_pi_bridge_ready'
		'builtin' 'return' 0
	}
	'builtin' 'typeset' -ga precmd_functions
	precmd_functions+=(_tern_pi_bridge_ready)
fi
