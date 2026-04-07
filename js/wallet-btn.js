/**
 * Wallet connect/disconnect button in the nav bar.
 * Requires wallet.js to be loaded first.
 */
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('walletBtn');
    if (!btn) return;

    const textEl = btn.querySelector('.wallet-btn-text');

    function updateWalletBtn() {
        if (pnpPublicKey) {
            textEl.textContent = shortenAddress(pnpPublicKey.toString());
            btn.classList.add('connected');
            btn.title = pnpPublicKey.toString() + ' (click to disconnect)';
        } else {
            textEl.textContent = 'Connect';
            btn.classList.remove('connected');
            btn.title = 'Connect Phantom Wallet';
        }
    }

    btn.addEventListener('click', async () => {
        if (pnpPublicKey) {
            // Disconnect (token stays in DB for future restore)
            await disconnectWallet();
            updateWalletBtn();
            // Sync payment modal wallet UI if open
            if (typeof updateWalletUI === 'function') updateWalletUI(false);
            // Update runs counter to show no access
            if (typeof updateRunsCounter === 'function') {
                updateRunsCounter({}, null);
            }
            // Hide runs counter
            const counter = document.getElementById('runsCounter');
            if (counter) counter.classList.add('d-none');
            // Re-lock the tool — show payment overlay, lock form
            const overlay = document.getElementById('paymentOverlay');
            if (overlay) overlay.classList.remove('d-none');
            const form = document.getElementById('uploadForm')
                || document.getElementById('labelerForm')
                || document.getElementById('tisForm')
                || document.getElementById('salesTaxForm');
            if (form) form.classList.add('payment-locked');
        } else {
            // Connect
            const pubkey = await connectWallet();
            if (pubkey) {
                updateWalletBtn();
                // Check rewards membership
                const access = await checkTokenBalance();
                if (access && access.has_access) {
                    // Clear any pending sign prompt
                    const signPrompt = document.querySelector('.rewards-sign-prompt');
                    if (signPrompt) signPrompt.remove();
                    if (typeof checkToolAccess === 'function') {
                        const tool = document.getElementById('runsCounter')?.dataset?.tool;
                        if (tool) checkToolAccess(tool);
                    }
                } else if (typeof tryWalletRestore === 'function') {
                    // Try wallet-based restore for previous crypto payments
                    const restored = await tryWalletRestore();
                    if (restored) {
                        const tool = document.getElementById('runsCounter')?.dataset?.tool;
                        if (tool && typeof checkToolAccess === 'function') {
                            checkToolAccess(tool);
                        }
                        // Unlock the tool
                        const overlay = document.getElementById('paymentOverlay');
                        if (overlay) overlay.classList.add('d-none');
                        const form = document.getElementById('uploadForm')
                            || document.getElementById('labelerForm')
                            || document.getElementById('tisForm')
                            || document.getElementById('salesTaxForm');
                        if (form) form.classList.remove('payment-locked');
                    } else {
                        // Wallet connected but no rewards or restore — check if they qualify
                        checkAndPromptRewardsSignature();
                    }
                }
            }
        }
    });

    // On load: try auto-connect and update button
    (async () => {
        const autoConnected = await tryWalletAutoConnect();
        updateWalletBtn();
        if (autoConnected) {
            // Check if rewards are already active
            const access = await checkAccess();
            if (!access || !access.valid || access.method !== 'memecoin') {
                checkAndPromptRewardsSignature();
            }
        }
    })();

    // Expose for accountChanged listener to call after reload
    window._updateWalletBtn = updateWalletBtn;
});
