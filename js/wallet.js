/**
 * PnP Wallet Connection & Authentication
 * Handles Phantom wallet connection, signing, and rewards membership checks.
 * Shared across all tool pages.
 *
 * Storage strategy:
 *   sessionStorage — wallet connection state (clears on hard refresh / new tab)
 *   localStorage   — manual payment sessions only (survives everything)
 *
 * Sign strategy:
 *   ONE signMessage() per connect flow. checkTokenBalance() uses a promise
 *   guard so concurrent callers share the same sign instead of double-prompting.
 */

// Wallet state
let pnpWallet = null;
let pnpPublicKey = null;
let pnpWalletAuthed = false;
let pnpWalletTier = null;

// API base - same origin
const PNP_API = '';

// Sign message shown in Phantom popup
const PNP_SIGN_MESSAGE = 'Sign this message to verify wallet ownership and activate your $PNP rewards tier on pnp.tax.\n\nThis is NOT a transaction and costs no SOL.';

/**
 * Connect Phantom wallet.
 * Returns the public key string or null.
 */
async function connectWallet() {
    if (!window.solana || !window.solana.isPhantom) {
        alert('Please install Phantom Wallet to pay with crypto.');
        window.open('https://phantom.app/', '_blank');
        return null;
    }

    try {
        const resp = await window.solana.connect();
        pnpWallet = window.solana;
        pnpPublicKey = resp.publicKey;

        sessionStorage.setItem('pnp_wallet', pnpPublicKey.toString());
        sessionStorage.removeItem('pnp_disconnected');
        return pnpPublicKey.toString();
    } catch (e) {
        console.error('[Wallet] Connect rejected:', e);
        return null;
    }
}

/**
 * Disconnect wallet.
 * Clears local state and cookie. Token stays in DB for future restore.
 */
async function disconnectWallet() {
    try {
        if (window.solana && window.solana.isConnected) {
            await window.solana.disconnect();
        }
    } catch (e) {
        console.error('[Wallet] Disconnect error:', e);
    }

    pnpWallet = null;
    pnpPublicKey = null;
    pnpWalletAuthed = false;
    pnpWalletTier = null;

    sessionStorage.removeItem('pnp_wallet');
    sessionStorage.setItem('pnp_disconnected', '1');
    sessionStorage.removeItem('pnp_tier');

    // Clear the cookie only — don't delete the token from DB.
    fetch('/api/payments/access/clear-cookie', {
        method: 'POST',
        credentials: 'include',
    }).catch(e => console.debug("[PnP]", e));

    // Remove gold theme when wallet disconnects
    if (typeof disableGoldTheme === 'function') {
        disableGoldTheme();
    }
}

/**
 * Check rewards membership via token balance and get tier-based access.
 * Also attempts to restore a previous paid session if no token rewards
 * (handled server-side in the check-access endpoint).
 *
 * Uses a promise guard: if called concurrently, the second caller awaits
 * the same promise instead of triggering a second signMessage().
 *
 * Returns access info or null.
 */
let _checkTokenBalancePromise = null;

async function checkTokenBalance() {
    // Promise guard — concurrent callers share the same sign flow
    if (_checkTokenBalancePromise) return _checkTokenBalancePromise;
    _checkTokenBalancePromise = _doCheckTokenBalance();
    try {
        return await _checkTokenBalancePromise;
    } finally {
        _checkTokenBalancePromise = null;
    }
}

async function _doCheckTokenBalance() {
    if (!pnpPublicKey || !pnpWallet) return null;

    try {
        // 1. Request a fresh nonce
        const nonceRes = await fetch(`${PNP_API}/api/payments/crypto/auth-nonce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: pnpPublicKey.toString() }),
        });
        const nonceData = await nonceRes.json();
        if (!nonceData.ok) return null;

        // 2. Single sign — clear message in Phantom popup
        const message = PNP_SIGN_MESSAGE + `\n\nNonce: ${nonceData.nonce}`;
        const encodedMessage = new TextEncoder().encode(message);
        const signedMessage = await pnpWallet.signMessage(encodedMessage, 'utf8');
        const signature = btoa(String.fromCharCode(...signedMessage.signature));

        // 3. Check rewards + attempt restore (one endpoint does both)
        const res = await fetch(`${PNP_API}/api/payments/token/check-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                wallet: pnpPublicKey.toString(),
                nonce: nonceData.nonce,
                signature: signature,
            }),
        });

        const data = await res.json();

        if (data.error === 'rate_limited') {
            console.warn('[Wallet] RPC rate limited during rewards check');
            const statusEl = document.getElementById('paymentStatus');
            const checkBtn = document.getElementById('paymentConnectWallet');
            if (typeof showRateLimitWarning === 'function') {
                showRateLimitWarning(checkBtn, statusEl);
            } else if (statusEl) {
                statusEl.textContent = 'Solana RPC rate limited. Please wait 15 seconds...';
                statusEl.style.color = '#CEBA4C';
                statusEl.style.display = 'block';
            }
            return null;
        }

        // Signature accepted — wallet is authenticated
        pnpWalletAuthed = true;

        if (data.has_access && data.tier) {
            pnpWalletTier = data.tier;
            sessionStorage.setItem('pnp_tier', data.tier);
        }

        return data;
    } catch (e) {
        console.error('[Wallet] Rewards check error:', e);
        return null;
    }
}

/**
 * Listen for Phantom account changes (wallet switch).
 * Logs out the old session so stale access doesn't persist.
 */
function listenForAccountChanges() {
    if (!window.solana || !window.solana.isPhantom) return;

    window.solana.on('accountChanged', async (newPublicKey) => {
        const oldKey = pnpPublicKey ? pnpPublicKey.toString() : null;
        const newKey = newPublicKey ? newPublicKey.toString() : null;

        if (!newPublicKey || (oldKey && oldKey !== newKey)) {
            pnpWallet = null;
            pnpPublicKey = null;
            pnpWalletAuthed = false;
            pnpWalletTier = null;
            sessionStorage.removeItem('pnp_wallet');
            sessionStorage.removeItem('pnp_tier');
            sessionStorage.removeItem('pnp_disconnected');
            fetch('/api/payments/access/clear-cookie', {
                method: 'POST', credentials: 'include'
            }).catch(e => console.debug("[PnP]", e));
            if (typeof disableGoldTheme === 'function') disableGoldTheme();
            location.reload();
        }
    });
}

// Auto-attach listener when Phantom is available
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', listenForAccountChanges);
} else {
    listenForAccountChanges();
}

/**
 * Try auto-connect if wallet was previously connected in this session.
 * Uses sessionStorage — won't auto-connect in new tabs or after hard refresh.
 */
async function tryWalletAutoConnect() {
    if (!window.solana || !window.solana.isPhantom) return false;

    // User explicitly disconnected this session
    if (sessionStorage.getItem('pnp_disconnected') === '1') return false;

    try {
        await window.solana.connect({ onlyIfTrusted: true });

        if (window.solana.isConnected && window.solana.publicKey) {
            pnpWallet = window.solana;
            pnpPublicKey = window.solana.publicKey;
            return true;
        }
    } catch (e) {
        // Not trusted - that's fine
    }

    return false;
}

/**
 * Shorten a Solana address for display.
 */
function shortenAddress(addr) {
    if (!addr || addr.length < 10) return addr || '';
    return addr.slice(0, 4) + '...' + addr.slice(-4);
}

/**
 * Get the stored access token.
 * Cookie is httpOnly so JS can't read it — return empty string.
 */
function getAccessToken() {
    return '';
}

/**
 * Store an access token.
 * No-op: backend sets the httpOnly cookie directly.
 */
function storeAccessToken(token) {
    // Cookie is set by the backend response
}

/**
 * Clear access cookie without deleting the token from DB.
 */
function clearAccessToken() {
    sessionStorage.removeItem('pnp_tier');
    fetch(`${PNP_API}/api/payments/access/clear-cookie`, {
        method: 'POST',
        credentials: 'include',
    }).catch(e => console.debug("[PnP]", e));
}

/**
 * Quick check if we have a valid access cookie that the backend accepts.
 * Returns { valid, tools, runs_left } or null.
 */
async function checkAccess() {
    try {
        const res = await fetch(`${PNP_API}/api/payments/access/verify`, {
            credentials: 'include',
        });

        if (res.ok) {
            return await res.json();
        }

        // 401 means the cookie is already gone on the server side — no need
        // to POST /clear-cookie just to re-clear it. Skip the extra request.
        return null;
    } catch (e) {
        console.error('[Wallet] Access check error:', e);
        return null;
    }
}

/**
 * Lightweight client-side token balance check via public RPC.
 * No signature needed — reads on-chain data directly.
 * Returns { balance, tier, tierName, runsDesc } or null on error.
 */
async function checkBalanceClientSide(walletAddress) {
    try {
        let pricing = window._pnpPricingData;
        if (!pricing) {
            const res = await fetch(`${PNP_API}/api/payments/pricing`);
            if (!res.ok) return null;
            pricing = await res.json();
        }

        const mint = pricing.memecoin_mint;
        const rpcUrl = pricing.sol && pricing.sol.rpc_url;
        const tiers = pricing.memecoin_tiers;
        if (!mint || !rpcUrl || !tiers) return null;

        const rpcRes = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1,
                method: 'getTokenAccountsByOwner',
                params: [
                    walletAddress,
                    { mint: mint },
                    { encoding: 'jsonParsed' }
                ]
            })
        });

        if (!rpcRes.ok) return null;
        const rpcData = await rpcRes.json();

        const accounts = rpcData.result && rpcData.result.value;
        if (!accounts || accounts.length === 0) return null;

        let totalBalance = 0;
        for (const acct of accounts) {
            const info = acct.account.data.parsed.info;
            totalBalance += parseInt(info.tokenAmount.amount, 10) / Math.pow(10, info.tokenAmount.decimals);
        }

        const thresholds = Object.keys(tiers).map(Number).sort((a, b) => b - a);
        const tierNames = { 30000000: 'Whale VIP', 10000000: 'Shark Elite', 1000000: 'Fish Starter' };
        let tier = null, tierName = null, runsDesc = null;

        for (const t of thresholds) {
            if (totalBalance >= t) {
                tier = t;
                tierName = tierNames[t] || 'Token Holder';
                runsDesc = tiers[String(t)];
                break;
            }
        }

        if (!tier) return null;
        return { balance: totalBalance, tier, tierName, runsDesc };
    } catch (e) {
        console.debug('[Wallet] Client-side balance check failed:', e);
        return null;
    }
}

/**
 * Show a callout prompting the user to sign for rewards activation.
 */
function showRewardsSignPrompt(tierName, runsDesc) {
    if (sessionStorage.getItem('pnp_rewards_prompt_dismissed')) return;
    if (window._pnpMethod === 'memecoin') return;
    if (document.querySelector('.rewards-sign-prompt')) return;

    const counter = document.getElementById('runsCounter');
    if (!counter) return;

    counter.classList.remove('d-none');

    const prompt = document.createElement('div');
    prompt.className = 'rewards-sign-prompt';
    prompt.innerHTML =
        '<div class="callout-title">You qualify for $PNP rewards!</div>' +
        '<div style="margin:0.3rem 0">Your wallet qualifies for <strong>' + tierName + '</strong> — ' + runsDesc + '</div>' +
        '<button type="button" class="rewards-sign-btn">Sign to Activate</button>' +
        '<div class="callout-dismiss">Dismiss</div>';

    counter.appendChild(prompt);

    counter.style.borderColor = 'rgba(206, 186, 76, 0.7)';
    counter.style.boxShadow = '0 0 16px rgba(206, 186, 76, 0.2)';

    function dismiss() {
        sessionStorage.setItem('pnp_rewards_prompt_dismissed', '1');
        prompt.classList.add('runs-callout-exit');
        counter.style.borderColor = '';
        counter.style.boxShadow = '';
        setTimeout(() => prompt.remove(), 300);
    }

    prompt.querySelector('.rewards-sign-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Verifying rewards...';
        try {
            const access = await checkTokenBalance();
            if (access && access.has_access) {
                prompt.remove();
                counter.style.borderColor = '';
                counter.style.boxShadow = '';
                const tool = counter.dataset.tool || 'bank';
                if (typeof checkToolAccess === 'function') checkToolAccess(tool);
            } else {
                btn.disabled = false;
                btn.textContent = 'Sign to Activate';
            }
        } catch (err) {
            btn.disabled = false;
            btn.textContent = 'Sign to Activate';
        }
    });

    prompt.querySelector('.callout-dismiss').addEventListener('click', (e) => {
        e.stopPropagation();
        dismiss();
    });
}

/**
 * Orchestrator: check if connected wallet qualifies for rewards
 * and show a sign prompt if they haven't activated yet.
 */
async function checkAndPromptRewardsSignature() {
    if (!pnpPublicKey) return;
    if (window._pnpMethod === 'memecoin') return;
    if (sessionStorage.getItem('pnp_rewards_prompt_dismissed')) return;

    const result = await checkBalanceClientSide(pnpPublicKey.toString());
    if (result) {
        showRewardsSignPrompt(result.tierName, result.runsDesc);
    }
}
