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
        const message = `PnP Login: ${nonceData.nonce}`;
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
async function checkTokenBalance() {
    if (!pnpPublicKey || !pnpWallet) return null;

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
        const message = `PnP Login: ${nonceData.nonce}`;
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
            pnpWalletTier = data.tier;
            localStorage.setItem('pnp_tier', data.tier);
            return data;
        }

        return data;
    } catch (e) {
        console.error('[Wallet] Rewards membership check error:', e);
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
