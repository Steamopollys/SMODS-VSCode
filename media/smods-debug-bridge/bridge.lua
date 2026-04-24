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
    local new_client = state.server:accept()
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

poll = function()
    if not state.server then return end
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

    local original = love.update
    local wrapped
    wrapped = function(dt)
        if love.update ~= wrapped then
            state.wrapped_update = nil
            install_update_hook()
            return love.update(dt)
        end
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
        if love.draw ~= wrapped then
            state.wrapped_draw = nil
            install_draw_hook()
            return love.draw()
        end
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
    if not socket then
        print('[smods-debug-bridge] luasocket missing; bridge disabled')
        return
    end

    local json_chunk, load_err = loadfile(root .. 'json.lua')
    if not json_chunk then
        print('[smods-debug-bridge] json.lua load failed: ' .. tostring(load_err))
        return
    end
    json = json_chunk()

    register_with_debugplus()

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
end

return M
