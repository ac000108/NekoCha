// 主页面JavaScript - 三级视图结构
let currentView = 'login';  // login | rooms | detail
let currentRoomId = null;
let isLoggedIn = false;
let connectionPollingTimer = null;
let roomStatusPollingTimer = null;

document.addEventListener('DOMContentLoaded', function() {
    loadTheme();
    disableContextMenu();
    initLoginView();
    initVersionCheck();
});

// ==================== 版本更新 ====================

let _notifiedUpdate = false;  // 避免重复弹 toast
let _updateModal = null;     // 弹窗 DOM

function _ensureUpdateModal() {
    if (_updateModal) return _updateModal;
    _updateModal = document.createElement('div');
    _updateModal.className = 'update-confirm-modal';
    _updateModal.innerHTML = `
        <div class="update-confirm-card">
            <div class="update-confirm-title">
                发现新版本 <span class="ver-new" id="updVerNew">v--</span>
            </div>
            <div class="update-confirm-desc" id="updDesc">点击下方按钮开始下载更新</div>
            <div class="upd-progress-wrap hidden" id="updProgressWrap">
                <div class="upd-progress-bar"><div class="upd-progress-fill" id="updProgressFill"></div></div>
                <div class="upd-progress-text" id="updProgressText">准备中...</div>
            </div>
            <div class="update-confirm-btns" id="updBtns">
                <button class="btn-cancel">取消</button>
                <button class="btn-confirm">立即更新</button>
            </div>
        </div>
    `;
    document.body.appendChild(_updateModal);
    return _updateModal;
}

function _showUpdateConfirm(latestVer, desc, onConfirm) {
    const modal = _ensureUpdateModal();
    $('updVerNew').textContent = `v${latestVer}`;
    $('updDesc').textContent = desc;
    $('updProgressWrap').classList.add('hidden');
    $('updBtns').classList.remove('hidden');
    modal.classList.add('show');

    const doClose = () => modal.classList.remove('show');
    const doConfirm = () => {
        doClose();
        onConfirm();
    };

    modal.querySelector('.btn-cancel').onclick = doClose;
    modal.querySelector('.btn-confirm').onclick = doConfirm;
    modal.onclick = (e) => { if (e.target === modal) doClose(); };
}

function _startBuiltinUpdate(latestVer, filesMap) {
    const modal = _ensureUpdateModal();
    $('updVerNew').textContent = `v${latestVer}`;
    $('updDesc').textContent = '正在下载更新...';
    $('updBtns').classList.add('hidden');
    $('updProgressWrap').classList.remove('hidden');
    $('updProgressFill').style.width = '0%';
    $('updProgressText').textContent = '准备中...';
    modal.classList.add('show');

    // 直接开始下载（filesMap 是 {rel: {sha256, size}} 或 {rel: sha256}）
    api('/api/start-update', 'POST', { files: filesMap }).then(() => {
        // 轮询进度：下载中 100ms，快完成时 50ms（等待进程退出）
        let interval = 100;
        const tick = () => {
            api('/api/update-progress').then(p => {
                const pct = p.percent || 0;
                $('updProgressFill').style.width = pct + '%';
                let txt = `${pct.toFixed(1)}%`;
                if (p.bytes_total > 0) {
                    const mb = (p.bytes_downloaded / 1024 / 1024).toFixed(1);
                    const totalMb = (p.bytes_total / 1024 / 1024).toFixed(1);
                    txt = `${mb}/${totalMb} MB · ${pct.toFixed(1)}%`;
                }
                if (p.current_file) txt += ` · ${p.current_file}`;
                $('updProgressText').textContent = txt;

                // 快下载完（>90%）或进入 applying 阶段 → 加速到 50ms 等进程结束
                if (pct >= 90 || p.phase === 'applying') {
                    interval = 50;
                }

                if (p.phase === 'applying' || p.phase === 'done') {
                    $('updProgressFill').style.width = '100%';
                    $('updProgressText').textContent = '下载完成，即将重启...';
                    // 继续快速轮询等进程退出（bat 会把主进程杀了，API 会断连）
                    const finalTick = setInterval(() => {
                        api('/api/update-progress').catch(() => {
                            // API 断连 = 主进程已退出（os._exit），bat 正在接力
                            clearInterval(finalTick);
                            $('updProgressText').textContent = '启动新版本中...';
                        });
                    }, 50);
                    return;
                }
                if (p.phase === 'error') {
                    $('updProgressText').textContent = '错误: ' + (p.error || '下载失败');
                    return;
                }

                // 继续下一轮
                setTimeout(tick, interval);
            }).catch(() => {
                setTimeout(tick, interval);
            });
        };
        tick();
    }).catch(() => {
        $('updProgressText').textContent = '启动更新失败';
    });
}

function initVersionCheck() {
    const versionInfo = $('versionInfo');
    const versionText = $('versionText');
    if (!versionInfo || !versionText) return;

    // 初始拉版本号
    api('/api/version').then(data => {
        versionText.textContent = `v${data.current || '--'}`;
        if (data.update_available) {
            versionInfo.classList.add('has-update');
            if (!_notifiedUpdate) {
                showNotification(`发现新版本 v${data.latest}，点击版本号更新`, 'success', 0);
                _notifiedUpdate = true;
            }
        }
    }).catch(() => {
        versionText.textContent = 'v--';
    });

    // 点击版本号 → 内置更新（差异下载 + bat 替换 + 自重启）
    // 点击版本号 → 先检查差异 → 弹确认框 → 用户确认后才下载
    versionInfo.addEventListener('click', () => {
        // 1. 先拉基础版本信息
        api('/api/version').then(v => {
            if (!v.update_available) {
                showNotification('已是最新版本', 'success');
                return;
            }
            // 2. 拉详细差异（文件数 + 大小）
            api('/api/check-update-internal').then(data => {
                if (!data.update_available || !data.files) {
                    showNotification('已是最新版本', 'success');
                    return;
                }
                // 3. 弹确认框
                let desc = `发现新版本 v${v.latest}，需要下载 ${data.need_download} 个文件`;
                if (data.need_download_bytes > 0) {
                    const mb = (data.need_download_bytes / 1024 / 1024).toFixed(1);
                    desc += `（约 ${mb} MB）`;
                }
                _showUpdateConfirm(v.latest, desc, () => {
                    // 4. 用户确认 → 开始下载
                    _startBuiltinUpdate(v.latest, data.files);
                });
            });
        });
    });

    // 每 1 分钟同步后端状态
    setInterval(() => {
        api('/api/version').then(data => {
            if (data.update_available) {
                if (!versionInfo.classList.contains('has-update')) {
                    versionInfo.classList.add('has-update');
                    if (!_notifiedUpdate) {
                        showNotification(`发现新版本 v${data.latest}，点击版本号更新`, 'success', 0);
                        _notifiedUpdate = true;
                    }
                }
            } else {
                versionInfo.classList.remove('has-update');
                _notifiedUpdate = false;
            }
        }).catch(() => {});
    }, 60 * 1000);
}

// ==================== 工具函数 ====================

function $(id) {
    return document.getElementById(id);
}

function api(url, method = 'GET', data = null) {
    return fetch(url, {
        method,
        headers: data ? { 'Content-Type': 'application/json' } : {},
        body: data ? JSON.stringify(data) : null
    }).then(res => res.json());
}

function showNotification(message, type = 'success', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('show'); });
    if (duration === 0) return;  // duration=0 持久显示
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => { toast.remove(); }, 300);
    }, duration);
}

function disableContextMenu() {
    document.addEventListener('contextmenu', function(e) {
        e.preventDefault();
    });
}

// ==================== 主题切换 ====================
// 4 种主题循环：粉色(默认) → 蓝色 → 紫色 → 绿色

const THEMES = ['', 'cool-theme', 'lavender-theme', 'mint-theme'];
const THEME_NAMES = {
    '': '粉色主题',
    'cool-theme': '蓝色主题',
    'lavender-theme': '紫色主题',
    'mint-theme': '绿色主题'
};

function cycleTheme() {
    const root = document.documentElement;
    const currentTheme = THEMES.find(t => t && root.classList.contains(t)) || '';
    const currentIndex = THEMES.indexOf(currentTheme);
    const nextIndex = (currentIndex + 1) % THEMES.length;
    const nextTheme = THEMES[nextIndex];

    // 移除所有主题类
    THEMES.forEach(t => { if (t) root.classList.remove(t); });
    // 添加新主题类
    if (nextTheme) root.classList.add(nextTheme);

    localStorage.setItem('theme', nextTheme || 'warm');
}

function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    const root = document.documentElement;
    // 清除所有主题类
    THEMES.forEach(t => { if (t) root.classList.remove(t); });
    // 应用保存的主题
    if (savedTheme && savedTheme !== 'warm') {
        if (THEMES.includes(savedTheme)) {
            root.classList.add(savedTheme);
        }
    }
}

// ==================== 视图切换 ====================

function switchView(view, params = {}) {
    const loginView = $('loginView');
    const mainAppView = $('mainAppView');
    const roomsListView = $('roomsListView');
    const roomDetailView = $('roomDetailView');
    const roomsHeader = $('roomsHeader');
    const detailHeader = $('detailHeader');

    // 隐藏所有视图
    loginView.classList.add('hidden');
    mainAppView.classList.add('hidden');
    roomsListView.classList.add('hidden');
    roomDetailView.classList.add('hidden');
    roomsHeader.classList.add('hidden');
    detailHeader.classList.add('hidden');

    // 停止房间列表轮询
    if (roomStatusPollingTimer) {
        clearInterval(roomStatusPollingTimer);
        roomStatusPollingTimer = null;
    }

    // 清所有 UI 残留状态（商店、插件设置、长按操作栏）
    resetAllUIState();

    currentView = view;

    if (view === 'login') {
        loginView.classList.remove('hidden');
        loginView.classList.add('active');
        stopAllPolling();
        startLoginQRCode();
    } else if (view === 'rooms') {
        mainAppView.classList.remove('hidden');
        roomsListView.classList.remove('hidden');
        roomsHeader.classList.remove('hidden');
        currentRoomId = null;
        loadRoomList();
        startRoomStatusPolling();
    } else if (view === 'detail') {
        mainAppView.classList.remove('hidden');
        roomDetailView.classList.remove('hidden');
        detailHeader.classList.remove('hidden');
        currentRoomId = params.roomId || null;
        if (currentRoomId) {
            enterRoomDetail(currentRoomId);
        }
    }
}

function stopAllPolling() {
    if (connectionPollingTimer) {
        clearInterval(connectionPollingTimer);
        connectionPollingTimer = null;
    }
    if (roomStatusPollingTimer) {
        clearInterval(roomStatusPollingTimer);
        roomStatusPollingTimer = null;
    }
}

// ==================== 登录视图 ====================

let loginQrCodeKey = null;
let loginCheckTimer = null;

function initLoginView() {
    $('loginStartBtn').addEventListener('click', startLoginQRCode);
    $('logoutBtn').addEventListener('click', handleLogout);
    $('addRoomBtn').addEventListener('click', handleAddRoom);
    $('newRoomIdInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') handleAddRoom();
    });
    $('backToListBtn').addEventListener('click', () => switchView('rooms'));

    // 风控推送 webhook
    $('alertSaveBtn').addEventListener('click', saveAlertWebhook);
    $('alertTestBtn').addEventListener('click', testAlertWebhook);

    // 主题按钮
    const themeBtn = $('themeToggleBtn');
    if (themeBtn) {
        themeBtn.addEventListener('click', cycleTheme);
    }

    // 回显已保存的 webhook
    loadAlertWebhook();

    checkLoginAndInit();
}

async function loadAlertWebhook() {
    try {
        const cfg = await api('/get_config');
        if (cfg.alert_webhook) {
            $('alertWebhookInput').value = cfg.alert_webhook;
        }
    } catch (e) { /* 静默失败 */ }
}

async function saveAlertWebhook() {
    const url = $('alertWebhookInput').value.trim();
    const msgEl = $('alertMsg');
    if (!url) {
        msgEl.className = 'login-alert-msg error';
        msgEl.textContent = '请输入 webhook URL';
        return;
    }
    try {
        const result = await api('/save_config', 'POST', { alert_webhook: url });
        if (result.success) {
            msgEl.className = 'login-alert-msg success';
            msgEl.textContent = '✅ 已保存';
        } else {
            msgEl.className = 'login-alert-msg error';
            msgEl.textContent = '❌ ' + (result.message || '保存失败');
        }
    } catch (e) {
        msgEl.className = 'login-alert-msg error';
        msgEl.textContent = '❌ ' + e.message;
    }
}

async function testAlertWebhook() {
    const url = $('alertWebhookInput').value.trim();
    const msgEl = $('alertMsg');
    if (!url) {
        msgEl.className = 'login-alert-msg error';
        msgEl.textContent = '请先输入 webhook URL';
        return;
    }
    try {
        msgEl.className = 'login-alert-msg';
        msgEl.textContent = '推送中...';
        const result = await api('/api/alert/test', 'POST', { webhook: url });
        if (result.success) {
            msgEl.className = 'login-alert-msg success';
            msgEl.textContent = '✅ ' + result.message;
        } else {
            msgEl.className = 'login-alert-msg error';
            msgEl.textContent = '❌ ' + (result.message || '推送失败');
        }
    } catch (e) {
        msgEl.className = 'login-alert-msg error';
        msgEl.textContent = '❌ ' + e.message;
    }
}

async function checkLoginAndInit() {
    try {
        const result = await api('/api/check_login_status');
        if (result.success && result.is_login) {
            isLoggedIn = true;
            showLoggedInUser(result);
            switchView('rooms');
        } else {
            isLoggedIn = false;
            switchView('login');
        }
    } catch (e) {
        console.error('检查登录状态失败:', e);
        switchView('login');
    }
}

function showLoggedInUser(info) {
    $('loggedInSection').classList.remove('hidden');
    $('userAvatarText').textContent = info.username ? info.username[0] : '?';
    $('displayUsername').textContent = info.username || '';
}

function showLoggedOutUser() {
    $('loggedInSection').classList.add('hidden');
}

async function startLoginQRCode() {
    const btn = $('loginStartBtn');
    btn.textContent = '加载中...';
    btn.disabled = true;

    try {
        const result = await api('/get_qrcode');
        if (result.success) {
            loginQrCodeKey = result.qrcode_key;
            const img = $('loginQrcodeImg');
            img.src = result.qrcode_data;
            img.onload = function() { img.classList.add('loaded'); };
            $('loginStatus').textContent = '等待扫码...';
            $('loginStatus').className = 'login-status-text';
            btn.style.display = 'none';
            startLoginStatusPolling();
        } else {
            $('loginStatus').textContent = '获取二维码失败';
            $('loginStatus').className = 'login-status-text error';
            btn.textContent = 'SCAN_QR';
            btn.disabled = false;
        }
    } catch (e) {
        $('loginStatus').textContent = '获取二维码失败';
        $('loginStatus').className = 'login-status-text error';
        btn.textContent = 'SCAN_QR';
        btn.disabled = false;
    }
}

function startLoginStatusPolling() {
    if (loginCheckTimer) clearTimeout(loginCheckTimer);

    api('/check_login?qrcode_key=' + loginQrCodeKey).then(result => {
        if (!loginQrCodeKey) return;

        if (result.success) {
            if (result.status === 'success') {
                $('loginStatus').textContent = '✅ 登录成功！';
                $('loginStatus').className = 'login-status-text success';
                setTimeout(() => {
                    loginQrCodeKey = null;
                    isLoggedIn = true;
                    checkLoginAndInit();
                }, 1000);
            } else if (result.status === 'expired') {
                $('loginStatus').textContent = '二维码已过期，刷新中...';
                startLoginQRCode();
            } else if (result.status === 'scanned') {
                $('loginStatus').textContent = '已扫码，请确认...';
                loginCheckTimer = setTimeout(startLoginStatusPolling, 2000);
            } else {
                $('loginStatus').textContent = '等待扫码...';
                loginCheckTimer = setTimeout(startLoginStatusPolling, 2000);
            }
        } else {
            loginCheckTimer = setTimeout(startLoginStatusPolling, 2000);
        }
    }).catch(e => {
        loginCheckTimer = setTimeout(startLoginStatusPolling, 2000);
    });
}

async function handleLogout() {
    const result = await api('/logout', 'POST');
    if (result.success) {
        isLoggedIn = false;
        showLoggedOutUser();
        stopAllPolling();
        showNotification('已退出登录');
        switchView('login');
    }
}

// ==================== 房间管理 ====================

async function loadRoomList() {
    try {
        const result = await api('/rooms');
        if (result.success) {
            renderRoomList(result.data);
        } else {
            showNotification(result.message || '加载房间列表失败', 'error');
        }
    } catch (e) {
        showNotification('加载房间列表失败', 'error');
    }
}

function getRoomStatusInfo(room) {
    const OFF = { cls: 'room-off', text: '', badge: '' };
    if (!room.is_listening) return OFF;
    const map = {
        1: { cls: 'room-online',   text: '直播中', badge: 'badge-live' },
        2: { cls: 'room-round',    text: '轮播中', badge: 'badge-round' },
    };
    return map[room.live_status] || { cls: 'room-not-live', text: '未开播', badge: 'badge-not-live' };
}

function renderRoomList(rooms) {
    const grid = $('roomsGrid');
    const countEl = $('roomsCount');
    const listContainer = $('roomListContainer');

    countEl.textContent = `// ${rooms.length} room`;

    // 左侧列表
    listContainer.innerHTML = '';
    if (rooms.length === 0) {
        listContainer.innerHTML = '<div class="empty-state"><div class="empty-icon">📡</div><div class="empty-text">还没有房间</div><div class="empty-hint">在上方输入房间号添加</div></div>';
    } else {
        rooms.forEach(room => {
            const proxyUrl = room.avatar_url ? `/api/proxy/avatar?url=${encodeURIComponent(room.avatar_url)}` : '';
            const avatarHtml = proxyUrl
                ? `<img src="${proxyUrl}" alt="avatar" class="room-item-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="room-item-avatar" style="display:none">${room.anchor_name ? room.anchor_name[0] : '?'}</div>`
                : `<div class="room-item-avatar">${room.anchor_name ? room.anchor_name[0] : '?'}</div>`;
            const item = document.createElement('div');
            item.className = 'room-list-item';
            const st = getRoomStatusInfo(room);
            item.innerHTML = `
                ${avatarHtml}
                <div class="room-item-info">
                    <div class="room-item-name">${room.anchor_name || '房间 ' + room.room_id}</div>
                    <div class="room-item-id">${room.room_id}</div>
                </div>
                <div class="room-item-status">
                    ${st.badge ? `<span class="listening-badge ${st.badge}"></span>` : ''}
                </div>
            `;
            item.onclick = () => switchView('detail', { roomId: room.room_id });
            listContainer.appendChild(item);
        });
    }

    // 右侧网格
    grid.innerHTML = '';
    if (rooms.length === 0) {
        grid.innerHTML = '<div class="empty-state"><div class="empty-icon">📡</div><div class="empty-text">还没有添加直播间</div><div class="empty-hint">在上方输入房间号添加</div></div>';
    } else {
        rooms.forEach(room => {
            const st = getRoomStatusInfo(room);
            const proxyUrl = room.avatar_url ? `/api/proxy/avatar?url=${encodeURIComponent(room.avatar_url)}` : '';
            const avatarHtml = proxyUrl
                ? `<img src="${proxyUrl}" alt="avatar" class="room-card-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';this.closest('.room-card').style.backgroundImage=''"><div class="room-card-avatar" style="display:none">${room.anchor_name ? room.anchor_name[0] : '?'}</div>`
                : `<div class="room-card-avatar">${room.anchor_name ? room.anchor_name[0] : '?'}</div>`;
            const card = document.createElement('div');
            card.className = 'room-card ' + st.cls;
            if (proxyUrl) card.style.backgroundImage = `url('${proxyUrl}')`;
            card.innerHTML = `
                <div class="room-card-header">
                    ${avatarHtml}
                    <div class="room-card-status-line">
                        <span class="dot"></span>
                        <span class="room-card-status-text">${st.text}</span>
                    </div>
                    <div class="room-card-info">
                        <div class="room-card-name">${room.anchor_name || '未知主播'}</div>
                        <div class="room-card-id">${room.room_id}</div>
                    </div>
                    <div class="room-card-actions">
                        <button class="btn toggle-btn room-action-btn" onclick="event.stopPropagation(); toggleRoomListen('${room.room_id}', this)" title="${room.is_listening ? '停止监听' : '开始监听'}">
                            ${room.is_listening ? '■' : '▶'}
                        </button>
                        ${!room.anchor_name ? `<button class="btn toggle-btn room-action-btn" onclick="event.stopPropagation(); refreshRoomInfo('${room.room_id}')" title="刷新主播信息">↻</button>` : ''}
                        <button class="btn toggle-btn room-action-btn room-delete-btn" title="长按删除">
                            <span>✕</span>
                        </button>
                    </div>
                </div>
            `;
            card.onclick = () => switchView('detail', { roomId: room.room_id });
            // 删除按钮：长按 1s 删除；松手取消
            const deleteBtn = card.querySelector('.room-delete-btn');
            let timer, done = false;
            const onDown = () => {
                if (done) return;
                deleteBtn.classList.add('pressing');
                timer = setTimeout(() => {
                    done = true;
                    card.classList.add('deleting');
                    setTimeout(() => removeRoom(room.room_id), 600);  // 等卡片动效跑完
                }, 1000);
            };
            const onUp = () => {
                clearTimeout(timer);
                deleteBtn.classList.remove('pressing');
            };
            ['mousedown', 'touchstart'].forEach(ev => deleteBtn.addEventListener(ev, onDown, { passive: true }));
            ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(ev => deleteBtn.addEventListener(ev, onUp));
            deleteBtn.addEventListener('click', e => e.stopPropagation());
            grid.appendChild(card);
        });
    }
}

async function handleAddRoom() {
    const input = $('newRoomIdInput');
    const roomId = input.value.trim();
    if (!roomId) {
        showNotification('请输入直播间ID', 'error');
        return;
    }

    try {
        const result = await api('/rooms', 'POST', { room_id: roomId });
        if (result.success) {
            input.value = '';
            const msg = result.warning ? `房间添加成功（${result.warning}）` : '房间添加成功';
            showNotification(msg);
            await loadRoomList();
        } else {
            showNotification(result.message || '添加失败', 'error');
        }
    } catch (e) {
        showNotification('添加房间失败', 'error');
    }
}

async function removeRoom(roomId) {
    try {
        const result = await api('/rooms/' + roomId, 'DELETE');
        if (result.success) {
            showNotification('房间已删除');
            await loadRoomList();
        } else {
            showNotification(result.message || '删除失败', 'error');
        }
    } catch (e) {
        showNotification('删除失败', 'error');
    }
}

async function refreshRoomInfo(roomId) {
    try {
        showNotification('正在获取主播信息...');
        const result = await api('/rooms/' + roomId, 'PUT', { fetch_from_api: true });
        if (result.success) {
            showNotification('主播信息已更新');
            await loadRoomList();
        } else {
            showNotification(result.message || '获取失败', 'error');
        }
    } catch (e) {
        showNotification('获取主播信息失败', 'error');
    }
}

async function toggleRoomListen(roomId, btn) {
    if (btn.disabled) return;  // 防重入
    const isListening = btn.textContent.trim() === '■';
    const actionUrl = isListening ? '/rooms/' + roomId + '/stop' : '/rooms/' + roomId + '/listen';
    const actionLabel = isListening ? '停止监听' : '开始监听';

    btn.disabled = true;
    try {
        const result = await api(actionUrl, 'POST');
        if (result.success) {
            showNotification(result.message || actionLabel + '成功');
        } else {
            showNotification(result.message || actionLabel + '失败', 'error');
        }
        await updateSingleRoomStatus(roomId);
    } catch (e) {
        showNotification('操作失败', 'error');
    } finally {
        btn.disabled = false;
    }
}

async function updateSingleRoomStatus(roomId) {
    try {
        const result = await api('/rooms/status');
        if (!result.success || !result.data[roomId]) return;
        const status = result.data[roomId];

        // 更新房间列表卡片
        const cards = document.querySelectorAll('.room-card');
        cards.forEach(card => {
            const idEl = card.querySelector('.room-card-id');
            if (idEl && idEl.textContent === roomId) {
                const st = getRoomStatusInfo(status);
                card.classList.remove('room-online', 'room-round', 'room-not-live', 'room-off');
                card.classList.add(st.cls);
                // 更新状态文字
                const textEl = card.querySelector('.room-card-status-text');
                if (textEl) textEl.textContent = st.text;
                const statusLine = card.querySelector('.room-card-status-line');
                if (statusLine) statusLine.style.visibility = st.text ? '' : 'hidden';
                // 更新按钮
                const btn = card.querySelector('.room-action-btn:not(.room-delete-btn)');
                if (btn) {
                    btn.innerHTML = status.is_listening ? '■' : '▶';
                    btn.title = status.is_listening ? '停止监听' : '开始监听';
                }
            }
        });

        // 更新列表项
        const items = document.querySelectorAll('.room-list-item');
        items.forEach(item => {
            const idEl = item.querySelector('.room-item-id');
            if (idEl && idEl.textContent === roomId) {
                const st = getRoomStatusInfo(status);
                const badge = item.querySelector('.listening-badge');
                if (st.badge) {
                    if (!badge) {
                        const newBadge = document.createElement('span');
                        newBadge.className = `listening-badge ${st.badge}`;
                        item.querySelector('.room-item-status')?.appendChild(newBadge);
                    } else {
                        badge.className = `listening-badge ${st.badge}`;
                    }
                } else if (badge) {
                    badge.remove();
                }
            }
        });
    } catch (e) {}
}

// ==================== 房间详情视图 ====================

async function enterRoomDetail(roomId) {
    currentRoomId = roomId;

    // 获取房间信息（包括主播名）
    let roomInfo = null;
    try {
        const listResult = await api('/rooms');
        if (listResult.success) {
            roomInfo = listResult.data.find(r => r.room_id === roomId);
        }
    } catch (e) {}

    const anchorName = roomInfo?.anchor_name || '';
    $('currentRoomIdDisplay').textContent = anchorName || `房间 ${roomId}`;

    // 更新内容标题
    const contentTitle = $('contentTitle');
    if (contentTitle) {
        contentTitle.textContent = anchorName ? `// ${anchorName}` : `// ROOM ${roomId}`;
    }

    const status = await getRoomStatus(roomId);

    await updateDetailStatus();
    if (roomId) {
        await loadRoomPlugins(roomId);
    } else {
        await loadPlugins();
    }
    startDetailStatusPolling();
}

async function getRoomStatus(roomId) {
    try {
        const result = await api('/rooms/status');
        if (result.success) {
            return result.data[roomId] || null;
        }
    } catch (e) {}
    return null;
}

async function updateDetailStatus() {
    if (!currentRoomId) return;
    const status = await getRoomStatus(currentRoomId);
    const dot = $('detailStatus');
    const text = $('detailStatusText');

    if (status && status.is_listening) {
        const ls = status.live_status;
        dot.className = 'status-dot ' + (ls === 1 ? 'online' : (ls === 2 ? 'round' : 'not-live'));
        if (ls === 1) {
            text.textContent = '直播中';
        } else if (ls === 2) {
            text.textContent = '轮播中';
        } else {
            text.textContent = '未开播';
        }
        // 同步更新侧边栏自动控制按钮的状态
        updateAutoPluginIndicators(ls);
    } else {
        dot.className = 'status-dot offline';
        text.textContent = '';
        dot.style.display = 'none';
        updateAutoPluginIndicators(-1);
    }
}

function updateAutoPluginIndicators(liveStatus) {
    const pluginList = $('pluginList');
    if (!pluginList) return;
    const autoBtns = pluginList.querySelectorAll('.mode-btn.auto-mode');
    autoBtns.forEach(btn => {
        const pluginItem = btn.closest('.plugin-item');
        if (!pluginItem) return;
        const isLive = liveStatus === 1;
        btn.classList.toggle('enabled', isLive);
        btn.classList.toggle('disabled', !isLive);
        btn.title = `自动模式 · ${isLive ? '开播中' : '未开播'}`;
        // 同步更新状态指示点
        const dot = pluginItem.querySelector('.status-dot');
        if (dot) {
            dot.className = 'status-dot ' + (isLive ? 'online' : 'offline');
        }
    });
}

function startDetailStatusPolling() {
    if (connectionPollingTimer) clearInterval(connectionPollingTimer);
    connectionPollingTimer = setInterval(() => {
        if (currentView === 'detail' && currentRoomId) {
            updateDetailStatus();
        }
    }, 5000);
}

function startRoomStatusPolling() {
    if (roomStatusPollingTimer) clearInterval(roomStatusPollingTimer);
    roomStatusPollingTimer = setInterval(async () => {
        if (currentView === 'rooms') {
            try {
                const result = await api('/rooms/status');
                if (result.success) {
                    document.querySelectorAll('.room-card').forEach(card => {
                        const id = card.querySelector('.room-card-id')?.textContent;
                        if (id && result.data[id]) {
                            const status = result.data[id];
                            const st = getRoomStatusInfo(status);
                            card.classList.remove('room-online', 'room-round', 'room-not-live', 'room-off');
                            if (status.is_listening) {
                                card.classList.add(st.cls);
                            } else {
                                card.classList.add('room-off');
                            }
                            // 同步更新状态文字
                            const textEl = card.querySelector('.room-card-status-text');
                            if (textEl) textEl.textContent = st.text;
                            const statusLine = card.querySelector('.room-card-status-line');
                            if (statusLine) statusLine.style.visibility = st.text ? '' : 'hidden';
                            const actionBtn = card.querySelector('.room-action-btn:not(.room-delete-btn)');
                            if (actionBtn) {
                                actionBtn.innerHTML = status.is_listening ? '■' : '▶';
                                actionBtn.title = status.is_listening ? '停止监听' : '开始监听';
                            }
                        }
                    });
                    document.querySelectorAll('.room-list-item').forEach(item => {
                        const idEl = item.querySelector('.room-item-id');
                        if (idEl && result.data[idEl.textContent]) {
                            const status = result.data[idEl.textContent];
                            const statusContainer = item.querySelector('.room-item-status');
                            if (statusContainer) {
                                if (status.is_listening) {
                                    const ls = status.live_status;
                                    const cls = ls === 1 ? 'badge-live' : (ls === 2 ? 'badge-round' : 'badge-not-live');
                                    statusContainer.innerHTML = `<span class="listening-badge ${cls}"></span>`;
                                } else {
                                    statusContainer.innerHTML = '';
                                }
                            }
                        }
                    });
                }
            } catch (e) {
                // 静默忽略轮询失败
            }
        }
    }, 5000);
}

// ==================== 插件管理 ====================

let allPlugins = [];
let availablePlugins = [];
let currentPlugin = '';
let openSettingsPlugin = '';
let isConfigModified = false;
let currentPluginName = '';
let _fullConfigCache = null;   // 保存渲染时的完整 config（含 _group_* 等 UI 元字段）
let isMarketVisible = false;
let _pluginView = 'installed'; // 'installed' | 'available'

async function loadPlugins() {
    // 从 CDN 拉取插件市场列表（临时使用，不缓存）
    const url = 'https://cdn.jsdelivr.net/gh/ac000108/NekoCha@main/plugins.json';
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error('fetch failed');
        const data = await resp.json();
        allPlugins = Array.isArray(data) ? data : (data.plugins || []);
        window.allPluginsLoaded = true;
        const searchInput = $('pluginSearch');
        const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';
        if (keyword) {
            const filtered = allPlugins.filter(p =>
                p.display_name.toLowerCase().includes(keyword) ||
                p.name.toLowerCase().includes(keyword)
            );
            renderSidebarPlugins(filtered);
        } else {
            renderSidebarPlugins(allPlugins);
        }
    } catch (e) {
        allPlugins = [];
        window.allPluginsLoaded = true;
        renderSidebarPlugins([]);
    }
    if (!openSettingsPlugin) {
        renderDefaultContent();
    }
}

async function loadRoomPlugins(roomId) {
    const result = await api('/rooms/' + roomId + '/plugins');
    if (result.success) {
        const data = result.data;
        allPlugins = data.installed || [];
        availablePlugins = data.available || [];
        window.allPluginsLoaded = true;
        const searchInput = $('pluginSearch');
        const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';
        if (keyword) {
            const filtered = allPlugins.filter(p =>
                p.display_name.toLowerCase().includes(keyword) ||
                p.name.toLowerCase().includes(keyword)
            );
            renderSidebarPlugins(filtered);
        } else {
            renderSidebarPlugins(allPlugins);
        }
        // 如果市场 modal 正打开着，不要清右侧（市场内容在 pluginContentArea 里）
        if (isMarketVisible) return;
        // 如果当前打开的设置面板对应的插件已被卸载，清掉右侧
        if (openSettingsPlugin) {
            const stillExists = allPlugins.some(p => p.name === openSettingsPlugin);
            if (!stillExists) {
                openSettingsPlugin = '';
                renderDefaultContent();
            }
        } else {
            renderDefaultContent();
        }
    } else {
        showNotification('加载房间插件配置失败', 'error');
    }
}

function renderDefaultContent() {
    const area = $('pluginContentArea');
    if (!area) return;
    const title = $('contentTitle');
    if (title) title.textContent = '// WELCOME';
    const saveBtnWrapper = $('saveBtnWrapper');
    if (saveBtnWrapper) saveBtnWrapper.innerHTML = '';
    area.innerHTML = '';
}

function resetAllUIState() {
    // 清所有 UI 层的残留状态
    hideMarketModal();
    openSettingsPlugin = '';
    isConfigModified = false;
}

function searchPlugins() {
    const searchInput = $('pluginSearch');
    const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';

    if (_pluginView === 'available') {
        // 在可用插件视图中搜索
        const filtered = keyword
            ? availablePlugins.filter(p => p.display_name.toLowerCase().includes(keyword) || p.name.toLowerCase().includes(keyword))
            : availablePlugins;
        _renderAvailablePlugins(filtered);
        return;
    }

    // 默认：已安装插件视图
    if (!allPlugins.length) { loadPlugins(); return; }
    const filtered = keyword
        ? allPlugins.filter(p => p.display_name.toLowerCase().includes(keyword) || p.name.toLowerCase().includes(keyword))
        : allPlugins;
    renderSidebarPlugins(filtered);
}

function _renderAvailablePlugins(available) {
    const keyword = ($('pluginSearch') || {}).value ? $('pluginSearch').value.toLowerCase().trim() : '';

    if (!available || available.length === 0) {
        $('pluginList').innerHTML = `
            <div class="available-plugins-header">
                <span>可用插件 (${availablePlugins.length})</span>
                <div class="available-plugins-actions">
                    <button class="btn icon-only add-plugin-btn" onclick="refreshAvailablePlugins()" title="刷新">↻</button>
                    <button class="btn icon-only add-plugin-btn" onclick="loadRoomPlugins(currentRoomId)" title="返回">←</button>
                </div>
            </div>
            <p style="color:#666;font-size:12px;text-align:center;padding:10px;">${keyword ? '无匹配结果' : '所有插件均已安装'}</p>
        `;
        return;
    }

    const list = available.map(p => `
        <div class="available-plugin-item" onclick="installRoomPlugin('${p.name}')">
            <span class="available-plugin-name">${p.display_name}</span>
            <span class="available-plugin-desc">${p.description || ''}</span>
            <span class="available-plugin-add">+</span>
        </div>
    `).join('');

    $('pluginList').innerHTML = `
        <div class="available-plugins-header">
            <span>可用插件 (${availablePlugins.length})</span>
            <div class="available-plugins-actions">
                <button class="btn icon-only add-plugin-btn" onclick="refreshAvailablePlugins()" title="刷新">↻</button>
                <button class="btn icon-only add-plugin-btn" onclick="loadRoomPlugins(currentRoomId)" title="返回">←</button>
            </div>
        </div>
        ${list}
    `;
}

function renderSidebarPlugins(plugins) {
    _pluginView = 'installed';
    const pluginList = $('pluginList');
    if (!pluginList) return;
    pluginList.innerHTML = '';
    if (plugins.length === 0) {
        pluginList.innerHTML = '<p style="color:#666;font-size:12px;text-align:center;padding:10px;">暂无插件</p>';
        return;
    }
    plugins.forEach(plugin => {
        const item = document.createElement('div');
        const isSettingsActive = openSettingsPlugin === plugin.name;
        item.className = `plugin-item${isSettingsActive ? ' active' : ''}`;
        item.onclick = () => {
            if (isMarketVisible) hideMarketModal();
            openPluginSettings(plugin.name, plugin.display_name);
        };
        item.onmousedown = null;
        item.onmouseup = null;
        item.onmouseleave = null;
        const displayBtn = plugin.has_display
            ? `<button class="btn toggle-btn mode-btn display-btn" onclick="event.stopPropagation(); window.open('/rooms/${currentRoomId}/plugins/${plugin.name}/display-page', '_blank')" title="打开展示页">D</button>`
            : '';
        let switchBtn;
        if (plugin.automatic) {
            const onLive = plugin.live_status === 1;
            switchBtn = `<button class="btn toggle-btn mode-btn auto-mode ${onLive ? 'enabled' : 'disabled'}"
                                onclick="event.stopPropagation(); cyclePluginMode('${plugin.name}')"
                                title="自动模式 · ${onLive ? '开播中' : '未开播'}">A</button>`;
        } else if (plugin.enabled) {
            switchBtn = `<button class="btn toggle-btn mode-btn enabled"
                                onclick="event.stopPropagation(); cyclePluginMode('${plugin.name}')"
                                title="手动启用">✓</button>`;
        } else {
            switchBtn = `<button class="btn toggle-btn mode-btn disabled"
                                onclick="event.stopPropagation(); cyclePluginMode('${plugin.name}')"
                                title="手动禁用">✗</button>`;
        }
        item.innerHTML = `
            <div class="plugin-row">
                <span class="status-dot ${plugin.automatic ? (plugin.live_status === 1 ? 'online' : 'offline') : (plugin.enabled ? 'online' : 'offline')}"></span>
                <span class="plugin-name">${plugin.display_name}</span>
                <div class="plugin-actions">
                    ${displayBtn}
                    ${switchBtn}
                </div>
            </div>
        `;
        pluginList.appendChild(item);
    });
}

async function uninstallPlugin(name) {
    if (!currentRoomId) return;

    const result = await api(`/rooms/${currentRoomId}/plugins/${name}`, 'DELETE');
    if (result.success) {
        await loadRoomPlugins(currentRoomId);
        showNotification(`已卸载插件「${name}」`);
    } else {
        showNotification(result.message || '卸载失败', 'error');
    }
}

async function showAvailablePlugins() {
    if (!currentRoomId) return;
    _pluginView = 'available';
    // 直接使用缓存数据，无需额外 API 调用
    if (!availablePlugins || availablePlugins.length === 0) {
        showNotification('所有插件均已安装', 'info');
        return;
    }
    // 进入视图后也应用当前搜索词
    searchPlugins();
}

async function refreshAvailablePlugins() {
    if (!currentRoomId) return;
    await loadPlugins();
    await loadRoomPlugins(currentRoomId);
    showAvailablePlugins();
}

async function installRoomPlugin(name) {
    if (!currentRoomId) return;
    const result = await api(`/rooms/${currentRoomId}/plugins/${name}`, 'POST');
    if (result.success) {
        showNotification(`已安装插件「${name}」`);
        await loadRoomPlugins(currentRoomId);
    } else {
        showNotification(result.message || '安装失败', 'error');
    }
}

async function cyclePluginMode(name) {
    if (!currentRoomId || currentView !== 'detail') return;
    const plugin = allPlugins.find(p => p.name === name);
    if (!plugin) return;

    let target = {};
    let msg = '';

    if (plugin.automatic) {
        // 自动模式 → 切回手动启用
        target = { enabled: true, config: { automatic: false } };
        msg = '已切回手动启用';
    } else if (plugin.enabled) {
        // 手动启用 → 手动禁用
        target = { enabled: false };
        msg = '已禁用插件';
    } else {
        // 手动禁用 → 自动模式
        target = { config: { automatic: true } };
        msg = '已启用自动控制';
    }

    const result = await api('/rooms/' + currentRoomId + '/plugins/' + name, 'PUT', target);
    if (result.success) {
        await loadRoomPlugins(currentRoomId);
        showNotification(msg);
    } else {
        showNotification(result.message || '操作失败', 'error');
    }
}

async function openPluginSettings(pluginName, displayName) {
    if (openSettingsPlugin === pluginName) {
        renderDefaultContent();
        openSettingsPlugin = '';
        isConfigModified = false;
        return;
    }
    isConfigModified = false;
    openSettingsPlugin = pluginName;
    if (currentRoomId && currentView === 'detail') {
        // 直接用已缓存的 allPlugins，不重复请求后端
        let plugin = allPlugins.find(p => p.name === pluginName);
        if (!plugin) {
            // 首次进入房间 allPlugins 可能还没加载，兜底拉一次
            await loadRoomPlugins(currentRoomId);
            plugin = allPlugins.find(p => p.name === pluginName);
        }
        if (plugin) {
            renderPluginSettingsContent({
                'name': plugin.name,
                'display_name': plugin.display_name,
                'config': plugin.config,
                'has_display': plugin.has_display,
                'enabled': plugin.enabled,
                'has_room_override': plugin.has_room_override
            });
        } else {
            showNotification('加载插件设置失败', 'error');
            openSettingsPlugin = '';
        }
    } else {
        showNotification('请先进入房间再编辑插件配置', 'info');
        openSettingsPlugin = '';
    }
}

async function savePluginSettingsAndClose(pluginName) {
    if (pluginName !== openSettingsPlugin) return;
    await savePluginSettings();
    isConfigModified = false;
    renderDefaultContent();
    openSettingsPlugin = '';
    if (currentRoomId && currentView === 'detail') {
        loadRoomPlugins(currentRoomId);
    } else {
        loadPlugins();
    }
}

async function cancelPluginSettings(pluginName) {
    if (pluginName !== openSettingsPlugin) return;
    renderDefaultContent();
    openSettingsPlugin = '';
    isConfigModified = false;
    if (currentRoomId && currentView === 'detail') {
        loadRoomPlugins(currentRoomId);
    } else {
        loadPlugins();
    }
}

// ==================== 插件配置渲染 ====================

const EXCLUDE_FIELDS = ['name', 'version', 'enabled', 'automatic'];
const FIELD_NAMES = { 'name': '插件名称', 'version': '版本', 'description': '描述', 'enabled': '启用',
    // 分组标题映射 (gid → 显示名)
    'bili': 'B站弹幕',
    'qq': 'QQ群通知',
    'douyin': '抖音通知',
    'captain': '舰长弹幕点歌',
};

function renderDescriptionField(description) {
    if (!description) return '';
    return `<div class="collapsible-section">
        <button type="button" class="collapsible-header" onclick="toggleCollapse(this)">
            <span class="collapsible-title">📝 插件说明</span>
            <span class="collapsible-icon">▼</span>
        </button>
        <div class="collapsible-content">
            <div class="plugin-description">${description}</div>
        </div>
    </div>`;
}

function toggleCollapse(button) {
    const section = button.parentElement;
    section.classList.toggle('expanded');
}

function renderBooleanField(key, value, displayName, fieldId) {
    return `<div class="form-item form-item-row">
  <label class="input-label" for="${fieldId}">${displayName}</label>
  <label class="toggle-wrapper" for="${fieldId}">
    <input type="checkbox" class="toggle-input" id="${fieldId}" name="${key}" ${value ? 'checked' : ''}>
    <span class="toggle-switch"></span>
  </label>
</div>`;
}

function renderStringField(key, value, displayName, fieldId) {
    if (typeof value === 'string' && value.length > 100 && value.includes('\n')) {
        return `<div class="form-item"><label class="input-label" for="${fieldId}">${displayName}</label><textarea class="form-textarea" id="${fieldId}" name="${key}" rows="4">${value}</textarea></div>`;
    }
    if (typeof value === 'string' && value.startsWith('#') && /^#[0-9A-Fa-f]{6}$/.test(value)) {
        return `<div class="form-item"><label class="input-label" for="${fieldId}">${displayName}</label><div class="color-wrapper"><input type="color" class="color-input" id="${fieldId}" name="${key}" value="${value}"><span class="color-text">${value}</span></div></div>`;
    }
    if (typeof value === 'string' && (value === 'true' || value === 'false')) {
        return `<div class="form-item"><label class="toggle-label" for="${fieldId}"><span class="toggle-text">${displayName}</span><input type="checkbox" class="toggle-input" id="${fieldId}" name="${key}" ${value === 'true' ? 'checked' : ''}><span class="toggle-switch"></span></label></div>`;
    }
    return `<div class="form-item"><label class="input-label" for="${fieldId}">${displayName}</label><input type="text" class="form-input" id="${fieldId}" name="${key}" value="${value}"></div>`;
}

function renderNumberField(key, value, displayName, fieldId) {
    return `<div class="form-item"><label class="input-label" for="${fieldId}">${displayName}</label><input type="number" class="form-input" id="${fieldId}" name="${key}" value="${value}"></div>`;
}

function renderArrayField(key, value, displayName) {
    let itemsHtml = '';
    for (let i = 0; i < value.length; i++) {
        itemsHtml += `<div class="list-item"><span class="list-item-index">${i + 1}.</span><input type="text" class="list-item-input" value="${value[i]}" data-index="${i}"><button class="btn btn-sm btn-danger list-item-remove" onclick="removeListItem(this)">✕</button></div>`;
    }
    return `<div class="form-item"><label class="input-label">${displayName}</label><div class="list-editor" data-field="${key}"><div class="list-items">${itemsHtml}</div><button type="button" class="btn btn-sm btn-primary list-add-btn" onclick="addListItem(this)">+ 添加项</button></div></div>`;
}

function renderObjectField(key, value, displayName) {
    const keys = Object.keys(value);
    const allBoolean = keys.length > 0 && keys.every(k => typeof value[k] === 'boolean');
    const allString = keys.length > 0 && keys.every(k => typeof value[k] === 'string');
    const hasOptions = keys.length <= 5 && allBoolean;

    if (allString) {
        let rowsHtml = '';
        for (const [k, v] of Object.entries(value)) {
            rowsHtml += `<div class="kvp-row"><input type="text" class="kvp-key" value="${k}" data-key="${k}" placeholder="关键词"><span class="kvp-sep">→</span><input type="text" class="kvp-value" value="${v}" placeholder="回复内容"><button type="button" class="btn btn-sm btn-danger kvp-remove" onclick="removeKvpItem(this)">✕</button></div>`;
        }
        return `<div class="form-item"><label class="input-label">${displayName}</label><div class="kvp-editor" data-field="${key}"><div class="kvp-items">${rowsHtml}</div><button type="button" class="btn btn-sm btn-primary kvp-add-btn" onclick="addKvpItem(this)">+ 添加词条</button></div></div>`;
    }
    if (hasOptions) {
        let optionsHtml = '';
        for (const [optKey, optValue] of Object.entries(value)) {
            if (typeof optValue === 'boolean') {
                optionsHtml += `<label class="checkbox-item"><input type="checkbox" class="setting-input" name="${key}.${optKey}" data-key="${key}.${optKey}" ${optValue ? 'checked' : ''}><span class="checkbox-custom"></span><span class="checkbox-text">${optKey}</span></label>`;
            }
        }
        return `<div class="form-item"><label class="input-label">${displayName}</label><div class="checkbox-grid">${optionsHtml}</div></div>`;
    }
    return `<div class="form-item"><label class="input-label">${displayName}</label><div class="json-editor"><textarea class="form-textarea code-textarea" name="${key}" data-key="${key}" rows="6">${JSON.stringify(value, null, 2)}</textarea></div></div>`;
}

function renderConfigField(key, value, allConfig, allConfigKeys, currentIndex) {
    if (EXCLUDE_FIELDS.includes(key) || key === 'description') return '';
    // 分割线: key 以 _divider_ 开头, value 是标题文字
    if (key.startsWith('_divider_')) {
        return `<div class="form-divider"><span class="form-divider-text">${value || key.replace(/^_divider_/, '')}</span></div>`;
    }
    // 分组开始: _group_begin_xxx
    // value 可为 null 或 {title: "..."}
    if (key.startsWith('_group_begin_')) {
        const gid = key.replace(/^_group_begin_/, '');
        const title = (value && value.title) || FIELD_NAMES[gid] || gid;
        // 推断 toggle 的 label 文字（分组内第一个布尔字段）
        let toggleLabel = '';
        if (allConfigKeys && allConfig) {
            for (let i = currentIndex + 1; i < allConfigKeys.length; i++) {
                const k = allConfigKeys[i];
                if (k.startsWith('_group_end_')) break;
                if (k.startsWith('_group_') || k.startsWith('_divider_')) continue;
                if (typeof allConfig[k] === 'boolean') {
                    toggleLabel = FIELD_NAMES[k] || k;
                    break;
                }
            }
        }
        return `<div class="form-group" data-group="${gid}" data-toggle-label="${toggleLabel}">
<div class="form-group-header">
  <span class="form-group-title">${toggleLabel || title}</span>
  <span class="form-group-header-right"></span>
</div>
<div class="form-group-body">`;
    }
    // 分组结束: _group_end_xxx
    if (key.startsWith('_group_end_')) {
        return `</div></div>`;
    }
    const fieldId = `field_${key}`;
    const fieldType = value === null ? 'text' : typeof value;
    const displayName = FIELD_NAMES[key] || key;
    if (fieldType === 'boolean') return renderBooleanField(key, value, displayName, fieldId);
    if (fieldType === 'number') return renderNumberField(key, value, displayName, fieldId);
    if (fieldType === 'string') return renderStringField(key, value, displayName, fieldId);
    if (Array.isArray(value)) return renderArrayField(key, value, displayName);
    if (fieldType === 'object' && value !== null) return renderObjectField(key, value, displayName);
    return `<div class="form-item"><label class="input-label" for="${fieldId}">${displayName}</label><input type="text" class="form-input" id="${fieldId}" name="${key}" data-key="${key}" value="${typeof value === 'object' ? JSON.stringify(value) : value}"></div>`;
}

function renderPluginSettingsContent(content) {
    const area = $('pluginContentArea');
    if (!area) return;
    const title = $('contentTitle');
    if (title) title.textContent = `// ${content.display_name.toUpperCase()}`;

    // 设置面板的保存/取消按钮（右侧 content-header 右上角）
    const saveBtnWrapper = $('saveBtnWrapper');
    if (saveBtnWrapper) {
        saveBtnWrapper.innerHTML = `
            <button class="btn save-plugin-btn" onclick="savePluginSettingsAndClose('${content.name}')" title="保存修改">✓ 保存</button>
            <button class="btn cancel-plugin-btn" onclick="cancelPluginSettings('${content.name}')" title="取消修改">✕ 取消</button>
        `;
    }

    currentPluginName = content.name;
    const pluginName = content.name;
    const config = content.config || {};
    _fullConfigCache = JSON.parse(JSON.stringify(config));  // 保存完整 config 原样副本

    let html = '';

    html += `<div class="settings-form"><form id="pluginSettingsForm"><input type="hidden" id="currentPluginNameHidden" value="${pluginName}"><div class="form-section">`;
    html += renderDescriptionField(config.description);
    const configKeys = Object.keys(config);
    for (let i = 0; i < configKeys.length; i++) {
        const key = configKeys[i];
        const value = config[key];
        if (key !== 'description') {
            html += renderConfigField(key, value, config, configKeys, i);
        }
    }
    html += `</div></form></div>`;
    area.innerHTML = html;

    // 初始化所有分组：把第一个开关移到 header 标题左边，折叠/展开联动
    document.querySelectorAll('.form-group').forEach(group => {
        const body = group.querySelector('.form-group-body');
        const headerRight = group.querySelector('.form-group-header-right');
        const title = group.querySelector('.form-group-title');
        if (!body || !headerRight || group.classList.contains('toggle-moved')) return;

        // 找 body 里第一个开关项（布尔字段）
        const toggleItem = body.querySelector('.form-item.form-item-row');
        if (toggleItem) {
            // 开关移到 header-right，header-right 保持在 title 右边（不推最右）
            headerRight.appendChild(toggleItem);
            group.classList.add('toggle-moved');

            // 同步折叠状态（开关关 → 折叠）
            const toggleInput = toggleItem.querySelector('.toggle-input');
            if (toggleInput) {
                syncGroupToggle(group, toggleInput.checked);
                toggleInput.addEventListener('change', () => {
                    syncGroupToggle(group, toggleInput.checked);
                });
            }
        }
    });

    setupAutoSave();
}

function syncGroupToggle(group, enabled) {
    const body = group.querySelector('.form-group-body');
    if (!body) return;
    if (enabled) {
        body.style.display = '';
        group.classList.remove('group-disabled');
    } else {
        body.style.display = 'none';
        group.classList.add('group-disabled');
    }
}

function toggleGroup(gid) {
    const group = document.querySelector(`.form-group[data-group="${gid}"]`);
    if (!group) return;
    const body = group.querySelector('.form-group-body');
    if (body.style.display === 'none') {
        body.style.display = '';
        group.classList.remove('group-disabled');
    } else {
        body.style.display = 'none';
    }
}

// header 点击：只点在标题/chevron 区域才切换折叠
function onGroupHeaderClick(gid, event) {
    // 点到开关区域 → 不触发折叠（让开关自己工作）
    if (event.target.closest('.toggle-wrapper') || event.target.closest('.toggle-input')) return;
    toggleGroup(gid);
}

function addListItem(btn) {
    const listEditor = btn.parentElement;
    const listItems = listEditor.querySelector('.list-items');
    const index = listItems.querySelectorAll('.list-item').length;
    const newItem = document.createElement('div');
    newItem.className = 'list-item';
    newItem.innerHTML = `<span class="list-item-index">${index + 1}.</span><input type="text" class="list-item-input" value="" data-index="${index}" oninput="isConfigModified = true;"><button class="btn btn-sm btn-danger list-item-remove" onclick="removeListItem(this)">✕</button>`;
    listItems.appendChild(newItem);
    isConfigModified = true;
}

function removeListItem(btn) {
    const listItem = btn.parentElement;
    const listItems = listItem.parentElement;
    listItem.remove();
    const items = listItems.querySelectorAll('.list-item');
    items.forEach((item, index) => {
        item.querySelector('.list-item-index').textContent = `${index + 1}.`;
        item.querySelector('.list-item-input').dataset.index = index;
    });
    isConfigModified = true;
}

function addKvpItem(btn) {
    const kvpEditor = btn.parentElement;
    const kvpItems = kvpEditor.querySelector('.kvp-items');
    const newItem = document.createElement('div');
    newItem.className = 'kvp-row';
    newItem.innerHTML = `<input type="text" class="kvp-key" value="" placeholder="关键词" oninput="isConfigModified = true;"><span class="kvp-sep">→</span><input type="text" class="kvp-value" value="" placeholder="回复内容" oninput="isConfigModified = true;"><button type="button" class="btn btn-sm btn-danger kvp-remove" onclick="removeKvpItem(this)">✕</button>`;
    kvpItems.appendChild(newItem);
    isConfigModified = true;
}

function removeKvpItem(btn) {
    btn.parentElement.remove();
    isConfigModified = true;
}

function setupAutoSave() {
    const area = $('pluginContentArea');
    if (!area) return;
    const inputs = area.querySelectorAll('.setting-input, .form-input, .form-textarea, .toggle-input, .color-input, .list-item-input, .kvp-key, .kvp-value');
    inputs.forEach(input => {
        if (input.type === 'checkbox' || input.type === 'radio') {
            input.addEventListener('change', () => { isConfigModified = true; });
        } else {
            input.addEventListener('input', () => { isConfigModified = true; });
        }
    });
}

async function savePluginSettings() {
    const pluginNameField = document.getElementById('currentPluginNameHidden');
    const pluginName = pluginNameField ? pluginNameField.value : currentPluginName;
    if (!pluginName) return;

    const config = {};
    const inputs = document.querySelectorAll('.setting-input, .form-input, .form-textarea, .toggle-input, .color-input');
    inputs.forEach(input => {
        const name = input.dataset.key || input.name;
        if (!name) return;
        if (name.includes('.')) {
            const parts = name.split('.');
            if (parts.length === 2) {
                const [group, key] = parts;
                if (!config[group]) config[group] = {};
                if (input.type === 'checkbox') config[group][key] = input.checked;
                else if (input.type === 'number') config[group][key] = parseFloat(input.value) || 0;
                else {
                    try { config[group][key] = JSON.parse(input.value); }
                    catch { config[group][key] = input.value; }
                }
            }
        } else {
            if (input.type === 'checkbox') config[name] = input.checked;
            else if (input.type === 'number') config[name] = parseFloat(input.value) || 0;
            else if (input.type === 'text' && input.classList.contains('code-textarea')) {
                try { config[name] = JSON.parse(input.value); }
                catch { config[name] = input.value; }
            } else {
                config[name] = input.value;
            }
        }
    });

    const listEditors = document.querySelectorAll('.list-editor');
    listEditors.forEach(editor => {
        const fieldName = editor.dataset.field;
        if (fieldName.includes('.')) {
            const [group, key] = fieldName.split('.');
            const values = Array.from(editor.querySelectorAll('.list-item-input')).map(i => i.value.trim()).filter(v => v);
            if (!config[group]) config[group] = {};
            config[group][key] = values;
        } else {
            const values = Array.from(editor.querySelectorAll('.list-item-input')).map(i => i.value.trim()).filter(v => v);
            if (values.length > 0) config[fieldName] = values;
        }
    });

    const kvpEditors = document.querySelectorAll('.kvp-editor');
    kvpEditors.forEach(editor => {
        const fieldName = editor.dataset.field;
        const dict = {};
        editor.querySelectorAll('.kvp-row').forEach(row => {
            const k = row.querySelector('.kvp-key').value.trim();
            const v = row.querySelector('.kvp-value').value.trim();
            if (k) dict[k] = v;
        });
        if (fieldName.includes('.')) {
            const [group, key] = fieldName.split('.');
            if (!config[group]) config[group] = {};
            config[group][key] = dict;
        } else {
            config[fieldName] = dict;
        }
    });

    const isInRoom = currentRoomId && currentView === 'detail';
    if (isInRoom) {
        // 用完整缓存 config（含 _group_* UI 元字段）做底，覆盖用户修改值
        const mergedConfig = _fullConfigCache ? JSON.parse(JSON.stringify(_fullConfigCache)) : {};
        Object.assign(mergedConfig, config);

        const result = await api(
            '/rooms/' + currentRoomId + '/plugins/' + pluginName,
            'PUT',
            { config: mergedConfig }
        );
        if (result.success) {
            showNotification('房间插件配置已保存');
        } else {
            showNotification(result.message || '保存失败', 'error');
        }
    } else {
        showNotification('请先进入房间再编辑插件配置', 'error');
    }
}

// ==================== 插件市场（卡片式） ====================

function hideMarketModal() {
    if (!isMarketVisible) return;
    const marketSearchContainer = $('marketSearchContainer');
    if (marketSearchContainer) {
        marketSearchContainer.classList.remove('active');
        marketSearchContainer.innerHTML = '';
    }
    isMarketVisible = false;
    renderDefaultContent();
    if (currentRoomId && currentView === 'detail') {
        loadRoomPlugins(currentRoomId);
    } else {
        loadPlugins();
    }
}

async function showMarketModal() {
    const contentArea = $('pluginContentArea');
    const contentTitle = $('contentTitle');
    const marketSearchContainer = $('marketSearchContainer');

    if (isMarketVisible) { hideMarketModal(); return; }

    // 放弃可能未保存的插件设置
    if (openSettingsPlugin) {
        openSettingsPlugin = '';
        isConfigModified = false;
        if (currentRoomId && currentView === 'detail') {
            loadRoomPlugins(currentRoomId);
        } else {
            loadPlugins();
        }
    }

    if (contentTitle) contentTitle.innerHTML = '// PLUGIN_MARKET';
    if (marketSearchContainer) {
        marketSearchContainer.innerHTML = '<div class="market-search-wrapper"><input type="text" class="market-search-box" placeholder="搜索插件..." id="marketSearchInput" oninput="filterMarketPlugins()"></div>';
        marketSearchContainer.classList.add('active');
    }
    if (contentArea) contentArea.innerHTML = '<div style="text-align:center; padding:50px; color:#666;">加载中...</div>';

    if (!currentRoomId) {
        if (contentArea) contentArea.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-muted);">请先进入房间再安装插件</div>';
        isMarketVisible = true;
        return;
    }

    try {
        // 一次请求：后端从 CDN 拉完整商店 + 本地已安装列表
        const roomResult = await api(`/rooms/${currentRoomId}/plugins?with_market=true`);
        if (!roomResult.success || !roomResult.data) throw new Error('failed');
        const storePlugins = roomResult.data.store_all || roomResult.data.available || [];
        const installedList = roomResult.data.installed || [];
        const installedMeta = {};
        installedList.forEach(p => { installedMeta[p.name] = p; });

        renderMarketPlugins(storePlugins, installedMeta);
        isMarketVisible = true;
    } catch (e) {
        if (contentArea) contentArea.innerHTML = '<div style="text-align:center; padding:50px; color:#666;">加载失败，请稍后重试</div>';
    }
}

function compareVersions(v1, v2) {
    const parts1 = (v1 || '').split('.').map(Number);
    const parts2 = (v2 || '').split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

function renderMarketPlugins(storePlugins, installedMeta) {
    const content = $('pluginContentArea');
    if (!content) return;
    if (!storePlugins || storePlugins.length === 0) {
        content.innerHTML = '<div style="text-align:center; padding:50px; color:var(--text-muted);">暂无插件</div>';
        return;
    }
    content.innerHTML = `<div class="market-plugin-grid" id="marketPluginGrid">${storePlugins.map(plugin => {
        const installed = installedMeta[plugin.name];
        let btnText = '安装插件';
        let btnClass = '';
        let versionText = `v${plugin.version || '1.0.0'}`;
        const isInstalled = !!installed;
        if (installed) {
            const installedVersion = installed.version || '1.0.0';
            const compare = compareVersions(plugin.version, installedVersion);
            if (compare > 0) { versionText = `v${installedVersion}→v${plugin.version}`; btnText = '更新插件'; }
            else if (compare === 0) { btnText = '已是最新'; btnClass = 'disabled'; }
            else { btnText = '已是最新'; btnClass = 'disabled'; }
        }
        const isDisabled = btnClass === 'disabled';
        const uninstallBtn = isInstalled ? `<button class="market-btn-uninstall" onclick="uninstallMarketPlugin('${plugin.name}', '${plugin.display_name}')">🗑️ 卸载</button>` : '';
        return `<div class="market-plugin-card" data-plugin="${plugin.name}" data-name="${plugin.name}" data-desc="${plugin.description || ''}">
            <div class="market-plugin-header"><div class="market-plugin-name">${plugin.display_name}</div><span class="market-plugin-version">${versionText}</span></div>
            <div class="market-plugin-desc">${plugin.description || ''}</div>
            <div class="market-card-actions">
                <button class="market-btn-install ${btnClass}" data-plugin="${plugin.name}" onclick="${isDisabled ? '' : `installMarketPlugin('${plugin.name}')`}" ${isDisabled ? 'disabled' : ''}>${btnText}</button>
                ${uninstallBtn}
                <div class="market-success-msg" id="market-success-${plugin.name}">✓ 安装成功</div>
            </div>
        </div>`;
    }).join('')}</div>`;
}

function filterMarketPlugins() {
    const input = document.getElementById('marketSearchInput');
    const cards = document.querySelectorAll('.market-plugin-card');
    const query = input ? input.value.toLowerCase().trim() : '';
    cards.forEach(card => {
        const name = card.getAttribute('data-name') || card.querySelector('.market-plugin-name')?.textContent.toLowerCase() || '';
        const desc = card.getAttribute('data-desc') || card.querySelector('.market-plugin-desc')?.textContent.toLowerCase() || '';
        card.style.display = (name.includes(query) || desc.includes(query)) ? 'flex' : 'none';
    });
}

const uninstallConfirmTimers = {};

function resetUninstallBtn(btn, name) {
    btn.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '🗑️ 卸载';
    delete btn.dataset.confirming;
    if (uninstallConfirmTimers[name]) { clearTimeout(uninstallConfirmTimers[name]); delete uninstallConfirmTimers[name]; }
}

function resetInstallBtn(btn) {
    const pluginName = btn.dataset.plugin || '';
    btn.removeAttribute('disabled');
    btn.classList.remove('disabled', 'installing');
    btn.textContent = '安装插件';
    btn.style.backgroundColor = '';
    btn.setAttribute('onclick', `installMarketPlugin('${pluginName}')`);
}

function installMarketPlugin(pluginName) {
    if (!currentRoomId) { showNotification('请先进入房间', 'error'); return; }
    const card = document.querySelector(`.market-plugin-card[data-plugin="${pluginName}"]`);
    const installBtn = card?.querySelector('.market-btn-install');
    const uninstallBtn = card?.querySelector('.market-btn-uninstall');
    const actionsContainer = card?.querySelector('.market-card-actions');
    if (!card || !installBtn) return;

    installBtn.disabled = true;
    installBtn.textContent = '安装中...';
    installBtn.classList.add('installing');

    api(`/rooms/${currentRoomId}/plugins/${pluginName}`, 'POST')
        .then(async (result) => {
            if (!result || !result.success) {
                installBtn.classList.remove('installing');
                installBtn.textContent = '安装失败';
                installBtn.style.backgroundColor = '#ff4d4f';
                showNotification(result?.message || '安装失败', 'error');
                setTimeout(() => { resetInstallBtn(installBtn); }, 2000);
                return;
            }
            // 刷新当前卡片显示
            installBtn.classList.remove('installing');
            installBtn.classList.add('disabled');
            installBtn.textContent = '已是最新';
            showNotification(`插件「${result.name || pluginName}」安装成功`);
            if (!uninstallBtn && actionsContainer) {
                const btn = document.createElement('button');
                btn.className = 'market-btn-uninstall';
                btn.textContent = '🗑️ 卸载';
                btn.onclick = () => uninstallMarketPlugin(pluginName, result.name || pluginName);
                actionsContainer.appendChild(btn);
            }
            // 同步刷新左侧已安装插件列表
            if (currentRoomId) {
                await loadRoomPlugins(currentRoomId);
            }
        })
        .catch(() => {
            installBtn.classList.remove('installing');
            installBtn.textContent = '安装失败';
            installBtn.style.backgroundColor = '#ff4d4f';
            showNotification('网络错误，安装失败', 'error');
            setTimeout(() => { resetInstallBtn(installBtn); }, 2000);
        });
}

async function uninstallMarketPlugin(pluginName, displayName) {
    const uninstallBtn = document.querySelector(`.market-plugin-card[data-plugin="${pluginName}"] .market-btn-uninstall`);
    const installBtn = document.querySelector(`.market-plugin-card[data-plugin="${pluginName}"] .market-btn-install`);
    if (!uninstallBtn) return;

    if (uninstallBtn.dataset.confirming === 'true') {
        clearTimeout(uninstallConfirmTimers[pluginName]);
        delete uninstallConfirmTimers[pluginName];
        delete uninstallBtn.dataset.confirming;
        uninstallBtn.disabled = true;
        uninstallBtn.textContent = '卸载中...';
        try {
            const result = await api(`/rooms/${currentRoomId}/plugins/${pluginName}`, 'DELETE');
            if (result.success) {
                showNotification(`插件「${displayName}」已卸载`);
                uninstallBtn.remove();
                resetInstallBtn(installBtn);
                if (currentRoomId) await loadRoomPlugins(currentRoomId);
            } else {
                showNotification(result.message || '卸载失败', 'error');
                resetUninstallBtn(uninstallBtn, pluginName);
            }
        } catch (e) {
            showNotification('卸载失败', 'error');
            resetUninstallBtn(uninstallBtn, pluginName);
        }
    } else {
        uninstallBtn.dataset.confirming = 'true';
        const originalText = uninstallBtn.textContent;
        uninstallBtn.textContent = '再次确认';
        uninstallConfirmTimers[pluginName] = setTimeout(() => { uninstallBtn.textContent = originalText; delete uninstallBtn.dataset.confirming; delete uninstallConfirmTimers[pluginName]; }, 3000);
    }
}

