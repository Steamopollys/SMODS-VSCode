--- Smods Debug Bridge core.
--- Opens a loopback TCP listener and speaks line-delimited JSON to the
--- smods-tools VS Code extension. Relays REPL/inspector commands and
--- pauses the game loop on demand.
---
--- Protocol:
---   request      {"id": N, "cmd": "...", "args": {...}}
---   response     {"id": N, "ok": true, "result": ...}
---                {"id": N, "ok": false, "error": "..."}
---   notification {"ev": "hello"|"pauseState"|"log", ...}

local M = {}

local DEFAULT_PORT = 43278
local FALLBACK_RANGE = 10
local READ_CHUNK = 4096
local MAX_PRETTY_DEPTH = 3
local MAX_STRING_LEN = 4096
local MAX_CHILDREN = 200

local socket
do
    local ok, mod = pcall(require, 'socket')
    if ok then socket = mod end
end

local json

local dpAPI
do
    local ok, mod = pcall(require, 'debugplus-api')
    if ok then dpAPI = mod end
end
local dp

local dpCore
do
    local ok, mod = pcall(require, 'debugplus.core')
    if ok then dpCore = mod end
end

local state = {
    port = nil,
    server = nil,
    client = nil,
    rx_buf = '',
    paused = false,
    step_frames = 0,
    wrapped_update = nil,
    wrapped_draw = nil,
    hello_sent = false,
    dp_log_cursor = 0,
}

local log_info = function(msg) print('[smods-debug-bridge] ' .. tostring(msg)) end
local log_warn = function(msg) print('[smods-debug-bridge] WARN: ' .. tostring(msg)) end

-- Forward declarations.
local send_notification, send_response, poll

---------------------------------------------------------------------------
-- Utility
---------------------------------------------------------------------------

local function truncate_string(s)
    if #s > MAX_STRING_LEN then
        return s:sub(1, MAX_STRING_LEN) .. ('...<+' .. (#s - MAX_STRING_LEN) .. ' chars>')
    end
    return s
end

local function pretty(v, depth, seen)
    depth = depth or 0
    seen = seen or {}
    local t = type(v)
    if t == 'nil' then return 'nil' end
    if t == 'boolean' or t == 'number' then return tostring(v) end
    if t == 'string' then return string.format('%q', truncate_string(v)) end
    if t == 'function' or t == 'userdata' or t == 'thread' then
        return '<' .. t .. '>'
    end
    if t == 'table' then
        if seen[v] then return '<cycle>' end
        seen[v] = true
        if depth >= MAX_PRETTY_DEPTH then return '{...}' end
        local parts = {}
        local count = 0
        for k, val in pairs(v) do
            count = count + 1
            if count > MAX_CHILDREN then
                parts[#parts + 1] = '...'
                break
            end
            local ks = type(k) == 'string' and k or ('[' .. tostring(k) .. ']')
            parts[#parts + 1] = ks .. ' = ' .. pretty(val, depth + 1, seen)
        end
        seen[v] = nil
        return '{ ' .. table.concat(parts, ', ') .. ' }'
    end
    return tostring(v)
end

local function short_preview(v)
    local t = type(v)
    if t == 'table' then
        local n = 0
        for _ in pairs(v) do n = n + 1 end
        return '{...} (' .. n .. ')'
    end
    return pretty(v, MAX_PRETTY_DEPTH - 1)
end

local function safe_encode(v)
    local t = type(v)
    if t == 'nil' or t == 'boolean' or t == 'number' or t == 'string' then
        return v, true
    end
    return pretty(v, 0), false
end

---------------------------------------------------------------------------
-- Path walker
---------------------------------------------------------------------------

local function eval_path(path)
    local chunk, err = load('return ' .. path, 'path', 't', _G)
    if not chunk then return nil, err end
    local ok, val = pcall(chunk)
    if not ok then return nil, val end
    return val
end

local function set_path(path, value_json)
    local decoded = json.decode(value_json)
    local lit
    local t = type(decoded)
    if t == 'nil' then lit = 'nil'
    elseif t == 'boolean' then lit = tostring(decoded)
    elseif t == 'number' then lit = tostring(decoded)
    elseif t == 'string' then lit = string.format('%q', decoded)
    else return nil, 'setPath only supports primitives, got ' .. t
    end
    local chunk, err = load(path .. ' = ' .. lit, 'setPath', 't', _G)
    if not chunk then return nil, err end
    local ok, err2 = pcall(chunk)
    if not ok then return nil, err2 end
    return true
end

---------------------------------------------------------------------------
-- Commands
---------------------------------------------------------------------------

local commands = {}

function commands.ping()
    return { pong = true, t = os.time() }
end

function commands.eval(args)
    local code = args and args.code or ''
    if code == '' then return nil, 'empty code' end
    local chunk, err = load('return ' .. code, 'repl', 't', _G)
    if not chunk then
        chunk, err = load(code, 'repl', 't', _G)
        if not chunk then return nil, err end
    end
    local results = { pcall(chunk) }
    local ok = table.remove(results, 1)
    if not ok then return nil, tostring(results[1]) end
    local pretties = {}
    local raw_first, raw_first_ok
    for i, v in ipairs(results) do
        pretties[i] = pretty(v, 0)
        if i == 1 then raw_first, raw_first_ok = safe_encode(v) end
    end
    return {
        pretty = #pretties > 0 and table.concat(pretties, ', ') or '',
        raw = raw_first_ok and raw_first or nil,
        type = results[1] and type(results[1]) or 'nil',
        n = #results,
    }
end

function commands.pause()
    state.paused = true
    send_notification({ ev = 'pauseState', paused = true })
    return { paused = true }
end

function commands.resume()
    state.paused = false
    state.step_frames = 0
    send_notification({ ev = 'pauseState', paused = false })
    return { paused = false }
end

function commands.step(args)
    if not state.paused then return nil, 'not paused' end
    local n = tonumber(args and args.frames) or 1
    if n < 1 then n = 1 end
    if n > 600 then n = 600 end
    state.step_frames = state.step_frames + n
    return { paused = true, queued = state.step_frames }
end

function commands.getPath(args)
    local path = args and args.path or ''
    if path == '' then return nil, 'empty path' end
    local val, err = eval_path(path)
    if err then return nil, err end
    local raw, raw_ok = safe_encode(val)
    return {
        type = type(val),
        pretty = type(val) == 'table' and short_preview(val) or pretty(val, 0),
        raw = raw_ok and raw or nil,
    }
end

function commands.setPath(args)
    local path = args and args.path or ''
    local vj = args and args.valueJson
    if path == '' or vj == nil then return nil, 'path and valueJson required' end
    local ok, err = set_path(path, vj)
    if not ok then return nil, err end
    return { ok = true }
end

local LUA_BUILTINS = {
    _G = true, _VERSION = true, assert = true, collectgarbage = true,
    dofile = true, error = true, gcinfo = true, getfenv = true, getmetatable = true,
    ipairs = true, load = true, loadfile = true, loadstring = true, module = true,
    newproxy = true, next = true, pairs = true, pcall = true, print = true,
    rawequal = true, rawget = true, rawlen = true, rawset = true, require = true,
    select = true, setfenv = true, setmetatable = true, tonumber = true,
    tostring = true, type = true, unpack = true, xpcall = true,
    coroutine = true, debug = true, io = true, math = true, os = true,
    package = true, string = true, table = true, bit = true, jit = true,
    ffi = true, utf8 = true,
    love = true, arg = true,
}

function commands.listGlobals()
    local out = {}
    for k, v in pairs(_G) do
        if type(k) == 'string' and not LUA_BUILTINS[k] then
            local t = type(v)
            if t == 'table' then
                out[#out + 1] = { key = k, type = t, preview = short_preview(v) }
            end
        end
    end
    table.sort(out, function(a, b) return a.key < b.key end)
    return { globals = out }
end

function commands.listChildren(args)
    local path = args and args.path or '_G'
    local limit = args and args.limit or MAX_CHILDREN
    local val, err = eval_path(path)
    if err then return nil, err end
    if type(val) ~= 'table' then
        return nil, 'not a table: ' .. type(val)
    end
    -- Materialise + sort all entries first so an explicit limit returns the
    -- first `limit` keys in stable order (numbers ascending, then strings).
    local entries = {}
    for k, v in pairs(val) do
        entries[#entries + 1] = { _k = k, _v = v }
    end
    table.sort(entries, function(a, b)
        local an, bn = type(a._k) == 'number', type(b._k) == 'number'
        if an and bn then return a._k < b._k end
        if an ~= bn then return an end
        return tostring(a._k) < tostring(b._k)
    end)
    local children = {}
    local truncated = #entries > limit
    for i = 1, math.min(#entries, limit) do
        local e = entries[i]
        children[i] = {
            key = tostring(e._k),
            keyType = type(e._k),
            type = type(e._v),
            preview = short_preview(e._v),
        }
    end
    return { children = children, truncated = truncated, total = #entries }
end

---------------------------------------------------------------------------
-- Profiler commands
---------------------------------------------------------------------------

function commands.profilerToggle()
    if not G then return nil, 'game not ready' end
    if G.prof then
        -- Mirror DebugPlus's stop sequence: stop → report() → nil out.
        if type(G.prof.stop) == 'function' then pcall(G.prof.stop) end
        local report = ''
        if type(G.prof.report) == 'function' then
            local ok, res = pcall(G.prof.report)
            if ok and type(res) == 'string' then report = res
            elseif not ok then report = 'profiler error: ' .. tostring(res) end
        end
        G.prof = nil
        if dp then dp.logger.info('Performance profiler stopped') end
        return { running = false, report = report }
    else
        if not dpCore then return nil, 'DebugPlus core unavailable' end
        local ok, err = pcall(dpCore.toggleProfiler)
        if not ok then
            return nil, 'profiler start failed: ' .. tostring(err)
        end
        if not G.prof then
            return nil, 'profiler did not start (DebugPlus fallback failed)'
        end
        return { running = true }
    end
end

---------------------------------------------------------------------------
-- Performance overlay command
---------------------------------------------------------------------------

function commands.perfOverlay()
    if not G then return nil, 'game not ready' end
    -- The lovely patch toggles perf_mode first, then calls togglePerfUI which
    -- just reads it. Replicate that sequence so disable actually works.
    G.SETTINGS.perf_mode = not G.F_ENABLE_PERF_OVERLAY
    if dpCore then
        dpCore.togglePerfUI()
    else
        G.F_ENABLE_PERF_OVERLAY = G.SETTINGS.perf_mode
    end
    return { enabled = G.F_ENABLE_PERF_OVERLAY or false }
end

function commands.perfStats()
    local fps = 0
    local frame_ms = 0
    if love and love.timer then
        if love.timer.getFPS then fps = love.timer.getFPS() or 0 end
        if love.timer.getAverageDelta then
            frame_ms = (love.timer.getAverageDelta() or 0) * 1000
        end
    end

    local mem_kb = collectgarbage('count') or 0

    local draw_calls, tex_mem_mb = 0, 0
    if love and love.graphics and love.graphics.getStats then
        local ok, stats = pcall(love.graphics.getStats)
        if ok and type(stats) == 'table' then
            draw_calls = stats.drawcalls or 0
            tex_mem_mb = (stats.texturememory or 0) / (1024 * 1024)
        end
    end

    local queues = {}
    if G and G.E_MANAGER and type(G.E_MANAGER.queues) == 'table' then
        for name, q in pairs(G.E_MANAGER.queues) do
            if type(q) == 'table' then queues[tostring(name)] = #q end
        end
    end

    return {
        fps = fps,
        frameTimeMs = frame_ms,
        memKb = mem_kb,
        drawCalls = draw_calls,
        textureMemMb = tex_mem_mb,
        eventQueues = queues,
        overlayEnabled = (G and G.F_ENABLE_PERF_OVERLAY) and true or false,
    }
end

---------------------------------------------------------------------------
-- Save state commands
---------------------------------------------------------------------------

local SAVE_SLOTS = { '1','2','3','4','5','6','7','8','9','0' }

local function valid_slot(slot)
    local s = tostring(slot or '')
    for _, v in ipairs(SAVE_SLOTS) do
        if s == v then return s end
    end
    return nil
end

local function save_state_path(slot)
    return G.SETTINGS.profile .. '/' .. 'debugsave' .. slot .. '.jkr'
end

function commands.saveStateSave(args)
    local slot = valid_slot(args and args.slot)
    if not slot then return nil, 'invalid slot — must be 0-9' end
    if not G or not G.STAGE or G.STAGE ~= G.STAGES.RUN then
        return nil, 'not in a run'
    end
    local bad = G.STATE == G.STATES.TAROT_PACK or G.STATE == G.STATES.PLANET_PACK or
        G.STATE == G.STATES.SPECTRAL_PACK or G.STATE == G.STATES.STANDARD_PACK or
        G.STATE == G.STATES.BUFFOON_PACK or G.STATE == G.STATES.SMODS_BOOSTER_OPENED
    if bad then return nil, 'cannot save while a pack is open' end
    save_run()
    compress_and_save(save_state_path(slot), G.ARGS.save_run)
    return { slot = slot, ok = true }
end

function commands.saveStateLoad(args)
    local slot = valid_slot(args and args.slot)
    if not slot then return nil, 'invalid slot — must be 0-9' end
    local path = save_state_path(slot)
    local data = get_compressed(path)
    if data == nil then return nil, 'slot ' .. slot .. ' is empty' end
    G:delete_run()
    G.SAVED_GAME = STR_UNPACK(data)
    G:start_run({ savetext = G.SAVED_GAME })
    return { slot = slot, ok = true }
end

---------------------------------------------------------------------------
-- Shader preview
---------------------------------------------------------------------------

local SHADER_PREVIEW_AREAS = {
    'hand', 'jokers', 'consumeables',
    'shop_jokers', 'shop_vouchers', 'shop_booster',
    'pack_cards', 'play', 'deck', 'discard',
}

local function shader_preview_areas()
    local out = {}
    for _, name in ipairs(SHADER_PREVIEW_AREAS) do
        if G[name] then out[#out + 1] = G[name] end
    end
    return out
end

local function shader_preview_revert_card(c)
    if not c or not c._smods_preview_state then return false end
    local s = c._smods_preview_state
    pcall(function() c:set_edition(s.prev_edition, true, true) end)
    G.SHADERS[s.user_key] = s.saved_shader
    G.P_CENTERS[s.edition_key] = nil
    if G.P_CENTER_POOLS and G.P_CENTER_POOLS.Edition then
        for i = #G.P_CENTER_POOLS.Edition, 1, -1 do
            local v = G.P_CENTER_POOLS.Edition[i]
            if v and v.key == s.edition_key then
                table.remove(G.P_CENTER_POOLS.Edition, i)
            end
        end
    end
    c._smods_preview_state = nil
    return true
end

local function shader_preview_revert_all()
    local count = 0
    for _, area in ipairs(shader_preview_areas()) do
        if area.cards then
            for _, c in ipairs(area.cards) do
                if shader_preview_revert_card(c) then count = count + 1 end
            end
        end
    end
    return count
end

local function shader_preview_pick_target()
    for _, area in ipairs(shader_preview_areas()) do
        if area.highlighted and area.highlighted[1] then
            return area.highlighted[1]
        end
    end
    if G.CONTROLLER then
        if G.CONTROLLER.dragging and G.CONTROLLER.dragging.target then
            return G.CONTROLLER.dragging.target
        end
        if G.CONTROLLER.hovering and G.CONTROLLER.hovering.target then
            return G.CONTROLLER.hovering.target
        end
        if G.CONTROLLER.focused and G.CONTROLLER.focused.target then
            return G.CONTROLLER.focused.target
        end
    end
    return nil
end

function commands.applyPreviewShader(args)
    if not (G and G.CONTROLLER and G.SHADERS and G.P_CENTERS and G.P_CENTER_POOLS) then
        return nil, 'engine not ready'
    end
    if type(args) ~= 'table' or type(args.source) ~= 'string' or args.source == '' then
        return nil, 'missing source'
    end
    local user_key = type(args.userKey) == 'string' and args.userKey or 'tmp'
    user_key = user_key:gsub('[^%w_]', '_')
    local edition_key = 'e_' .. user_key

    local ok, sh = pcall(love.graphics.newShader, args.source)
    if not ok then return nil, 'compile error: ' .. tostring(sh) end

    local target = shader_preview_pick_target()
    if not target or not target.set_edition then
        return nil, 'no selected card (click one to lift it first)'
    end

    -- Drop overrides on every other card so only one is active at a time.
    shader_preview_revert_all()

    -- The send-target list is the parsed vec2 extern names from the user
    -- shader, plus the shader key itself. The custom draw pcalls each so
    -- uniforms LÖVE optimized away don't crash sprite.lua's send.
    local send_names = {}
    if type(args.vec2Names) == 'table' then
        for _, n in ipairs(args.vec2Names) do
            if type(n) == 'string' then send_names[#send_names + 1] = n end
        end
    end
    local seen = {}
    for _, n in ipairs(send_names) do seen[n] = true end
    if not seen[user_key] then send_names[#send_names + 1] = user_key end

    local function preview_draw(self, card)
        local shader = G.SHADERS[self.shader]
        local sargs = card.ARGS and card.ARGS.send_to_shader
        if shader and sargs then
            for _, n in ipairs(send_names) do
                pcall(function() shader:send(n, sargs) end)
            end
        end
        pcall(function() card.children.center:draw_shader(self.shader, nil, nil) end)
        if card.children.front then
            local hide = false
            if card.should_hide_front then
                local hok, h = pcall(function() return card:should_hide_front() end)
                if hok then hide = h end
            end
            if not hide then
                pcall(function() card.children.front:draw_shader(self.shader, nil, nil) end)
            end
        end
    end

    local prev_edition_key = target.edition and target.edition.key or nil
    local saved_shader = G.SHADERS[user_key]

    G.SHADERS[user_key] = sh
    local edition_def = {
        key = edition_key,
        shader = user_key,
        config = {},
        set = 'Edition',
        weight = 0,
        in_shop = false,
        discovered = true,
        unlocked = true,
        draw = preview_draw,
    }
    G.P_CENTERS[edition_key] = edition_def
    table.insert(G.P_CENTER_POOLS.Edition, edition_def)

    local apply_ok, apply_err = pcall(function()
        target:set_edition(edition_key, true, true)
    end)
    if not apply_ok then
        G.SHADERS[user_key] = saved_shader
        G.P_CENTERS[edition_key] = nil
        for i = #G.P_CENTER_POOLS.Edition, 1, -1 do
            local v = G.P_CENTER_POOLS.Edition[i]
            if v and v.key == edition_key then
                table.remove(G.P_CENTER_POOLS.Edition, i)
            end
        end
        return nil, 'set_edition failed: ' .. tostring(apply_err)
    end

    target._smods_preview_state = {
        user_key = user_key,
        edition_key = edition_key,
        saved_shader = saved_shader,
        prev_edition = prev_edition_key,
    }

    local label = (target.config and target.config.center and target.config.center.key)
        or tostring(target)
    return { applied = true, label = label }
end

function commands.revertPreviewShaders()
    local count = shader_preview_revert_all()
    return { reverted = count }
end

function commands.saveStateList()
    local slots = {}
    for _, v in ipairs(SAVE_SLOTS) do
        local path = save_state_path(v)
        local info = love.filesystem.getInfo(path)
        slots[#slots + 1] = {
            slot = v,
            exists = info ~= nil,
            modtime = info and info.modtime or nil,
        }
    end
    return { slots = slots }
end

---------------------------------------------------------------------------
-- Socket I/O
---------------------------------------------------------------------------

send_notification = function(payload)
    if not state.client then return end
    local ok, line = pcall(json.encode, payload)
    if not ok then return end
    pcall(state.client.send, state.client, line .. '\n')
end

send_response = function(id, ok, result_or_err)
    if not state.client then return end
    local frame
    if ok then
        frame = { id = id, ok = true, result = result_or_err }
    else
        frame = { id = id, ok = false, error = tostring(result_or_err) }
    end
    local enc_ok, line = pcall(json.encode, frame)
    if not enc_ok then return end
    pcall(state.client.send, state.client, line .. '\n')
end

local function handle_line(line)
    local decode_ok, msg = pcall(json.decode, line)
    if not decode_ok or type(msg) ~= 'table' then
        log_warn('malformed frame: ' .. tostring(line))
        return
    end
    local id = msg.id
    local cmd = commands[msg.cmd]
    if not cmd then
        send_response(id, false, 'unknown cmd: ' .. tostring(msg.cmd))
        return
    end
    local handler_ok, result, err = pcall(cmd, msg.args)
    if not handler_ok then
        send_response(id, false, tostring(result))
        return
    end
    if result == nil then
        send_response(id, false, err or 'nil result')
        return
    end
    send_response(id, true, result)
end

local function drain_socket()
    if not state.client then return end
    while true do
        local data, err, partial = state.client:receive(READ_CHUNK)
        local chunk = data or partial
        if chunk and chunk ~= '' then
            state.rx_buf = state.rx_buf .. chunk
        end
        if err == 'closed' then
            pcall(state.client.close, state.client)
            state.client = nil
            state.hello_sent = false
            log_info('client disconnected')
            return
        elseif err == 'timeout' or not data then
            break
        else
            log_warn('receive error: ' .. tostring(err))
            break
        end
    end
    while true do
        local nl = state.rx_buf:find('\n', 1, true)
        if not nl then break end
        local line = state.rx_buf:sub(1, nl - 1)
        state.rx_buf = state.rx_buf:sub(nl + 1)
        if line ~= '' then handle_line(line) end
    end
end

local function send_hello()
    if state.hello_sent or not state.client then return end
    state.hello_sent = true
    local love_ver = 'unknown'
    if type(love) == 'table' and love.getVersion then
        local maj, min, rev = love.getVersion()
        love_ver = tostring(maj) .. '.' .. tostring(min) .. '.' .. tostring(rev)
    end
    send_notification({
        ev = 'hello',
        version = 1,
        port = state.port,
        love = love_ver,
        paused = state.paused,
        profilerRunning = G and G.prof ~= nil or false,
        perfOverlay = G and G.F_ENABLE_PERF_OVERLAY or false,
    })
end

local function accept_new_client()
    if not state.server then return end
    -- Re-assert non-blocking each tick: if any other mod or the LÖVE host
    -- toggles the listener's timeout, accept() can otherwise block the main
    -- thread and freeze the game at the last drawn frame.
    pcall(state.server.settimeout, state.server, 0)
    local ok, new_client_or_err = pcall(state.server.accept, state.server)
    if not ok then
        log_warn('accept failed: ' .. tostring(new_client_or_err))
        return
    end
    local new_client = new_client_or_err
    if not new_client then return end
    new_client:settimeout(0)
    if state.client then pcall(state.client.close, state.client) end
    state.client = new_client
    state.rx_buf = ''
    state.hello_sent = false
    log_info('client connected')
    send_hello()
end

local function drain_dp_logs()
    local logger_mod
    local ok, mod = pcall(require, 'debugplus.logger')
    if not ok or not mod or not mod.logs then return end
    logger_mod = mod
    local logs = logger_mod.logs
    local current = #logs
    if current == state.dp_log_cursor then return end
    if current < state.dp_log_cursor then state.dp_log_cursor = 0 end
    for i = state.dp_log_cursor + 1, current do
        local entry = logs[i]
        if entry and state.client then
            send_notification({
                ev = 'log',
                level = entry.level or 'INFO',
                name = entry.name,
                text = tostring(entry.str or entry.text or entry.msg or entry[1] or ''),
            })
        end
    end
    state.dp_log_cursor = current
end

local first_poll_logged = false
poll = function()
    if not state.server then return end
    if not first_poll_logged then
        first_poll_logged = true
        print('[smods-debug-bridge] bridge: first poll')
    end
    accept_new_client()
    drain_socket()
    drain_dp_logs()
end

---------------------------------------------------------------------------
-- love.update / love.draw hooks
---------------------------------------------------------------------------

local function install_update_hook()
    if not love or not love.update then return end
    if love.update == state.wrapped_update then return end

    -- Capture whatever love.update is now and always call it. If another mod
    -- wraps love.update after us we silently lose the hook for that frame —
    -- the previous "re-install + re-enter" approach caused infinite recursion
    -- when DebugPlus / Lovely runtime patches re-wrapped love.update after us.
    local original = love.update
    local wrapped
    wrapped = function(dt)
        poll()
        if state.paused then
            if state.step_frames <= 0 then return end
            state.step_frames = state.step_frames - 1
        end
        return original(dt)
    end
    state.wrapped_update = wrapped
    love.update = wrapped
end

local function install_draw_hook()
    if not love or not love.draw then return end
    if love.draw == state.wrapped_draw then return end

    local original = love.draw
    local wrapped
    wrapped = function()
        return original()
    end
    state.wrapped_draw = wrapped
    love.draw = wrapped
end

---------------------------------------------------------------------------
-- Listener setup
---------------------------------------------------------------------------

local function read_port_override(root)
    local f = io.open(root .. 'port.txt', 'r')
    if not f then return nil end
    local s = f:read('*l')
    f:close()
    local n = tonumber(s)
    if n and n >= 1024 and n <= 65535 then return n end
    return nil
end

local function bind_listener(preferred)
    for offset = 0, FALLBACK_RANGE do
        local port = preferred + offset
        local server, err = socket.bind('127.0.0.1', port)
        if server then
            server:settimeout(0)
            return server, port
        end
        log_warn('bind failed on ' .. port .. ': ' .. tostring(err))
    end
    return nil, 'no free port in range'
end

---------------------------------------------------------------------------
-- DebugPlus integration
---------------------------------------------------------------------------

local function register_with_debugplus()
    if not dpAPI then return end
    local reg, err = dpAPI.registerID('SmodsBridge')
    if not reg then
        log_warn('DebugPlus registerID failed: ' .. tostring(err))
        return
    end
    dp = reg
    log_info = dp.logger.info
    log_warn = dp.logger.warn

    if dp.addCommand then
        dp.addCommand({
            name = 'bridge',
            shortDesc = 'Smods debug-bridge status',
            desc = 'Reports listener port and client connection state.',
            exec = function()
                return 'bridge port=' .. tostring(state.port)
                    .. ' client=' .. (state.client and 'connected' or 'none')
                    .. ' paused=' .. tostring(state.paused), 'INFO'
            end,
        })
    end
end

---------------------------------------------------------------------------
-- Entry point
---------------------------------------------------------------------------

function M.start(root)
    root = root or ''
    print('[smods-debug-bridge] bridge: M.start root=' .. tostring(root))
    if not socket then
        print('[smods-debug-bridge] luasocket missing; bridge disabled')
        return
    end
    print('[smods-debug-bridge] bridge: socket ok')

    local json_chunk, load_err = loadfile(root .. 'json.lua')
    if not json_chunk then
        print('[smods-debug-bridge] json.lua load failed: ' .. tostring(load_err))
        return
    end
    json = json_chunk()
    print('[smods-debug-bridge] bridge: json loaded')

    register_with_debugplus()
    print('[smods-debug-bridge] bridge: debugplus registered')

    local preferred = read_port_override(root) or DEFAULT_PORT
    local server, port_or_err = bind_listener(preferred)
    if not server then
        log_warn('bind failed: ' .. tostring(port_or_err))
        return
    end
    state.server = server
    state.port = port_or_err
    log_info('listening on 127.0.0.1:' .. state.port)

    install_update_hook()
    install_draw_hook()
    print('[smods-debug-bridge] bridge: hooks installed')
end

return M
