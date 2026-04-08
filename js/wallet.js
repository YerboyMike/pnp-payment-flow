/**
 * PnP Wallet Connection & Authentication
 * Handles Phantom wallet connection, signing, and rewards membership checks.
 * Shared across all tool pages.
 */

// Wallet state
let pnpWallet = null;
let pnpPublicKey = null;
let pnpWalletAuthed = false;
let pnpWalletTier = null;
let pnpAuthNonce = null;
let pnpAuthSignature = null;

// API base - same origin
const PNP_API = '';

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

        localStorage.setItem('pnp_wallet', pnpPublicKey.toString());
        localStorage.removeItem('pnp_disconnected');
        return pnpPublicKey.toString();
    } catch (e) {
        console.error('[Wallet] Connect rejected:', e);
        return null;
    }
}

/**
 * Disconnect wallet.
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
    pnpAuthNonce = null;
    pnpAuthSignature = null;

    localStorage.removeItem('pnp_wallet');
    localStorage.setItem('pnp_disconnected', '1');
    localStorage.removeItem('pnp_tier');

    // Clear the cookie only — don't delete the token from DB.
    // The token stays so the user can restore access by reconnecting.
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
 * Authenticate wallet by signing a nonce message.
 * Returns true if successful.
 */
async function authenticateWallet() {
    if (!pnpPublicKey) {
        console.error('[Wallet] No public key to authenticate');
        return false;
    }

    try {
        // 1. Request nonce
        const nonceRes = await fetch(`${PNP_API}/api/payments/crypto/auth-nonce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: pnpPublicKey.toString() }),
        });

        const nonceData = await nonceRes.json();
        if (!nonceData.ok) {
            console.error('[Wallet] Nonce request failed:', nonceData);
            return false;
        }

        // 2. Sign the message
        const message = `PnP Login: ${nonceData.nonce}`;
        const encodedMessage = new TextEncoder().encode(message);
        const signedMessage = await pnpWallet.signMessage(encodedMessage, 'utf8');
        const signature = btoa(String.fromCharCode(...signedMessage.signature));

        // 3. Verify with backend
        const verifyRes = await fetch(`${PNP_API}/api/payments/crypto/auth-verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                wallet: pnpPublicKey.toString(),
                nonce: nonceData.nonce,
                signature: signature,
            }),
        });

        const verifyData = await verifyRes.json();
        if (verifyData.ok) {
            pnpWalletAuthed = true;
            pnpAuthNonce = nonceData.nonce;
            pnpAuthSignature = signature;
            return true;
        }

        console.error('[Wallet] Verification failed:', verifyData);
        return false;
    } catch (e) {
        console.error('[Wallet] Authentication error:', e);
        return false;
    }
}

/**
 * Try to restore access for a wallet that previously paid.
 * Requests a nonce, signs it, and calls the restore endpoint.
 * Returns restore data if successful, null otherwise.
 */
async function tryWalletRestore() {
    if (!pnpPublicKey || !pnpWallet) return null;

    try {
        // 1. Request nonce
        const nonceRes = await fetch(`${PNP_API}/api/payments/crypto/auth-nonce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: pnpPublicKey.toString() }),
        });
        const nonceData = await nonceRes.json();
        if (!nonceData.ok) return null;

        // 2. Sign the message
        const message = `Sign to verify wallet ownership for PnP Tax. This is not a transaction and costs no gas.\n\nNonce: ${nonceData.nonce}`;
        const encodedMessage = new TextEncoder().encode(message);
        const signedMessage = await pnpWallet.signMessage(encodedMessage, 'utf8');
        const signature = btoa(String.fromCharCode(...signedMessage.signature));

        // 3. Call restore endpoint
        const restoreRes = await fetch(`${PNP_API}/api/payments/crypto/restore-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                wallet: pnpPublicKey.toString(),
                nonce: nonceData.nonce,
                signature: signature,
            }),
        });

        if (restoreRes.ok) {
            const data = await restoreRes.json();
            if (data.ok && data.restored) {
                console.log('[Wallet] Access restored for wallet:', pnpPublicKey.toString().slice(0, 8) + '...');
                return data;
            }
        }

        return null;
    } catch (e) {
        // User rejected signing or network error — not an error, just no restore
        console.log('[Wallet] Restore not available:', e.message || e);
        return null;
    }
}

/**
 * Check rewards membership via token balance and get tier-based access.
 * Returns access info or null.
 */
let _checkTokenBalanceRunning = false;
async function checkTokenBalance() {
    if (!pnpPublicKey || !pnpWallet) return null;
    if (_checkTokenBalanceRunning) return null; // prevent duplicate sign popups
    _checkTokenBalanceRunning = true;

    try {
        // Get a fresh nonce for this check
        const nonceRes = await fetch(`${PNP_API}/api/payments/crypto/auth-nonce`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wallet: pnpPublicKey.toString() }),
        });
        const nonceData = await nonceRes.json();
        if (!nonceData.ok) return null;

        // Sign the nonce to prove wallet ownership
        const message = `Sign to verify wallet ownership for PnP Tax. This is not a transaction and costs no gas.\n\nNonce: ${nonceData.nonce}`;
        const encodedMessage = new TextEncoder().encode(message);
        const signedMessage = await pnpWallet.signMessage(encodedMessage, 'utf8');
        const signature = btoa(String.fromCharCode(...signedMessage.signature));

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
            console.warn('[Wallet] RPC rate limited during rewards membership check');
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

        // Signature was accepted — wallet is authenticated
        pnpWalletAuthed = true;

        if (data.has_access) {
            if (data.tier) {
                pnpWalletTier = data.tier;
                localStorage.setItem('pnp_tier', data.tier);
            }
            return data;
        }

        return data;
    } catch (e) {
        console.error('[Wallet] Rewards membership check error:', e);
        return null;
    } finally {
        _checkTokenBalanceRunning = false;
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
            // Clear local state without deleting the DB token
            pnpWallet = null;
            pnpPublicKey = null;
            pnpWalletAuthed = false;
            pnpWalletTier = null;
            localStorage.removeItem('pnp_wallet');
            localStorage.removeItem('pnp_tier');
            localStorage.removeItem('pnp_disconnected');
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
 * Try auto-connect if wallet was previously connected.
 */
async function tryWalletAutoConnect() {
    if (!window.solana || !window.solana.isPhantom) return false;

    // User explicitly disconnected — don't auto-reconnect
    if (localStorage.getItem('pnp_disconnected') === '1') return false;

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
 * Get the stored access token.
 * Cookie is httpOnly so JS can't read it — return empty string.
 * The browser sends the cookie automatically with credentials: 'include'.
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
 * Token stays for future wallet-based restore.
 */
function clearAccessToken() {
    localStorage.removeItem('pnp_tier');
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

        // Token invalid/expired - clear it
        clearAccessToken();
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
        // Get pricing data (cached by payment.js on page load)
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

        // RPC call to get token accounts
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

        // Sum balances across all token accounts for this mint
        let totalBalance = 0;
        for (const acct of accounts) {
            const info = acct.account.data.parsed.info;
            totalBalance += parseInt(info.tokenAmount.amount, 10) / Math.pow(10, info.tokenAmount.decimals);
        }

        // Map to tier (descending thresholds)
        const thresholds = Object.keys(tiers).map(Number).sort((a, b) => b - a);
        let tier = null;
        let tierName = null;
        let runsDesc = null;

        const tierNames = { 30000000: 'Whale VIP', 10000000: 'Shark Elite', 1000000: 'Fish Starter' };

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
    // Guard: already dismissed this session
    if (sessionStorage.getItem('pnp_rewards_prompt_dismissed')) return;
    // Guard: rewards already active
    if (window._pnpMethod === 'memecoin') return;
    // Guard: don't stack prompts
    if (document.querySelector('.rewards-sign-prompt')) return;

    const counter = document.getElementById('runsCounter');
    if (!counter) return;

    // Make counter visible so banner has an anchor
    counter.classList.remove('d-none');

    const prompt = document.createElement('div');
    prompt.className = 'rewards-sign-prompt';
    prompt.innerHTML =
        '<div class="callout-title">You qualify for $PNP rewards!</div>' +
        '<div style="margin:0.3rem 0">Your wallet qualifies for <strong>' + tierName + '</strong> — ' + runsDesc + '</div>' +
        '<button type="button" class="rewards-sign-btn">Sign to Activate</button>' +
        '<div class="callout-dismiss">Dismiss</div>';

    counter.appendChild(prompt);

    // Highlight the counter
    counter.style.borderColor = 'rgba(206, 186, 76, 0.7)';
    counter.style.boxShadow = '0 0 16px rgba(206, 186, 76, 0.2)';

    function dismiss() {
        sessionStorage.setItem('pnp_rewards_prompt_dismissed', '1');
        prompt.classList.add('runs-callout-exit');
        counter.style.borderColor = '';
        counter.style.boxShadow = '';
        setTimeout(() => prompt.remove(), 300);
    }

    // "Sign to Activate" button
    prompt.querySelector('.rewards-sign-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Signing...';
        try {
            const access = await checkTokenBalance();
            if (access && access.has_access) {
                prompt.remove();
                counter.style.borderColor = '';
                counter.style.boxShadow = '';
                // Refresh page access
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

    // Dismiss link
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
    // Guard: no wallet
    if (!pnpPublicKey) return;
    // Guard: rewards already active
    if (window._pnpMethod === 'memecoin') return;
    // Guard: dismissed this session
    if (sessionStorage.getItem('pnp_rewards_prompt_dismissed')) return;

    const result = await checkBalanceClientSide(pnpPublicKey.toString());
    if (result) {
        showRewardsSignPrompt(result.tierName, result.runsDesc);
    }
}
