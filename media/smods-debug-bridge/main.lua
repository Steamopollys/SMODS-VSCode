--- Smods Debug Bridge — entry point.
--- Loaded by Steamodded after DebugPlus. Boots the TCP listener and hooks
--- love.update so the extension can pause/resume the game.

local mod = SMODS and SMODS.current_mod
local root = mod and mod.path or ''

local function dofile_rel(name)
    return assert(loadfile(root .. name))()
end

local ok, err = pcall(function()
    local bridge = dofile_rel('bridge.lua')
    bridge.start(root)
end)

if not ok then
    print('[smods-debug-bridge] failed to start: ' .. tostring(err))
end
