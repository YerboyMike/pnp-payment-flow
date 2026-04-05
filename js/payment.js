/**
 * PnP Payment Flow
 * Handles payment modal, method selection, crypto transfers, Stripe checkout,
 * manual payments, and access token management.
 * Shared across all tool pages.
 */

// Payment state
let paymentModalOpen = false;
let currentPaymentTool = null;
let manualSessionWallet = null;
let manualSessionExpiry = null;
let manualTimerInterval = null;
let paymentProcessing = false;
let cachedPricing = null;

// Fetch pricing from backend and update all displayed prices
async function loadPricing() {
    try {
        const res = await fetch(`${PNP_API}/api/payments/pricing`);
        cachedPricing = await res.json();
        updateDisplayedPrices();
    } catch (e) {
        console.warn('[Pricing] Failed to load pricing:', e);
    }
}

function updateDisplayedPrices() {
    if (!cachedPricing) return;
    const p = cachedPricing;
    const priceMap = {
        'sol_single': `${p.sol.per_tool} SOL`,
        'sol_bundle': `${p.sol.bundle} SOL`,
        'usdc_single': `${p.usdc.per_tool} USDC`,
        'usdc_bundle': `${p.usdc.bundle} USDC`,
        'single': `$${p.stripe.per_tool}`,
        'bundle': `$${p.stripe.bundle}`,
    };
    document.querySelectorAll('.payment-option').forEach(opt => {
        const radio = opt.querySelector('input[type="radio"]');
        const priceSpan = opt.querySelector('.price');
        if (!radio || !priceSpan) return;
        if (priceMap[radio.value]) priceSpan.textContent = priceMap[radio.value];
    });

    // Inject grand opening promo banner if not already present
    if (!document.querySelector('.promo-banner')) {
        const header = document.querySelector('.payment-modal-header');
        if (header) {
            const banner = document.createElement('div');
            banner.className = 'promo-banner';
            banner.innerHTML = '<strong>Grand Opening Promo</strong> — Pay with SOL at a massive discount! Limited time only.';
            header.insertAdjacentElement('afterend', banner);
        }
    }
}

// Load pricing when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPricing);
} else {
    loadPricing();
}

// Runs quantity helpers
function getRunsQty() {
    const input = document.getElementById('runsQtyInput');
    return input ? Math.max(1, Math.min(50, parseInt(input.value) || 1)) : 1;
}

function updateRunsQtyUI() {
    const qty = getRunsQty();
    const label = document.getElementById('runsQtyLabel');
    const plural = document.getElementById('runsQtyPlural');
    if (label) label.textContent = qty;
    if (plural) plural.textContent = qty > 1 ? 's' : '';

    // Update displayed prices using cached pricing from backend
    if (!cachedPricing) return;
    const p = cachedPricing;
    document.querySelectorAll('.payment-option').forEach(opt => {
        const radio = opt.querySelector('input[type="radio"]');
        const priceSpan = opt.querySelector('.price');
        if (!radio || !priceSpan) return;
        const v = radio.value;
        let base = 0, symbol = '';
        if (v === 'sol_single') { base = p.sol.per_tool; symbol = ' SOL'; }
        else if (v === 'sol_bundle') { base = p.sol.bundle; symbol = ' SOL'; }
        else if (v === 'usdc_single') { base = p.usdc.per_tool; symbol = ' USDC'; }
        else if (v === 'usdc_bundle') { base = p.usdc.bundle; symbol = ' USDC'; }
        else if (v === 'single') { base = p.stripe.per_tool; symbol = ''; }
        else if (v === 'bundle') { base = p.stripe.bundle; symbol = ''; }
        if (base) {
            const isUsd = (v === 'single' || v === 'bundle');
            const total = parseFloat((base * qty).toPrecision(10));
            priceSpan.textContent = isUsd ? `$${total}` : `${total}${symbol}`;
        }
    });
}

// SPL Token program constants
const TOKEN_PROGRAM_ID_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID_STR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Derive the Associated Token Address for a given owner + mint.
 * Uses PublicKey.findProgramAddress([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM).
 */
function getAssociatedTokenAddress(ownerPubkey, mintPubkey) {
    const { PublicKey } = solanaWeb3;
    const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID_STR);
    const ataProgram = new PublicKey(ATA_PROGRAM_ID_STR);
    return PublicKey.findProgramAddress(
        [ownerPubkey.toBytes(), tokenProgram.toBytes(), mintPubkey.toBytes()],
        ataProgram,
    );
}

/**
 * Build a raw SPL Token TransferChecked instruction (index 12).
 * Data layout: [12, amount_u64_LE, decimals_u8] — 10 bytes total.
 */
function createTransferCheckedInstruction(source, mint, destination, owner, amount, decimals) {
    const { PublicKey, TransactionInstruction } = solanaWeb3;
    const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID_STR);

    // Encode instruction data: u8(12) + u64LE(amount) + u8(decimals)
    const data = new Uint8Array(1 + 8 + 1);
    data[0] = 12; // TransferChecked instruction index
    // Write amount as little-endian u64
    const lo = amount & 0xFFFFFFFF;
    const hi = Math.floor(amount / 0x100000000) & 0xFFFFFFFF;
    data[1] = lo & 0xFF;
    data[2] = (lo >> 8) & 0xFF;
    data[3] = (lo >> 16) & 0xFF;
    data[4] = (lo >> 24) & 0xFF;
    data[5] = hi & 0xFF;
    data[6] = (hi >> 8) & 0xFF;
    data[7] = (hi >> 16) & 0xFF;
    data[8] = (hi >> 24) & 0xFF;
    data[9] = decimals;

    return new TransactionInstruction({
        keys: [
            { pubkey: source,      isSigner: false, isWritable: true  }, // source ATA
            { pubkey: mint,        isSigner: false, isWritable: false }, // mint
            { pubkey: destination,  isSigner: false, isWritable: true  }, // destination ATA
            { pubkey: owner,       isSigner: true,  isWritable: false }, // owner (signer)
        ],
        programId: tokenProgram,
        data: data,
    });
}

/**
 * Show the payment modal for a specific tool.
 */
function showPaymentModal(tool) {
    currentPaymentTool = tool;
    const modal = document.getElementById('paymentModal');
    if (!modal) return;

    // Update tool name in modal
    const toolNameEl = modal.querySelector('.payment-tool-name');
    if (toolNameEl) {
        const names = { bank: 'Bank Processor', labeler: 'Smart Labeler', tis: 'TIS Generator', 'sales-tax': 'Sales Tax Helper' };
        toolNameEl.textContent = names[tool] || tool;
    }

    modal.style.display = 'flex';
    paymentModalOpen = true;

    // Try auto-connect wallet
    tryWalletAutoConnect().then(connected => {
        if (connected) {
            updateWalletUI(true);
        }
    });
}

/**
 * Close the payment modal.
 */
function closePaymentModal() {
    const modal = document.getElementById('paymentModal');
    if (modal) modal.style.display = 'none';
    paymentModalOpen = false;
    paymentProcessing = false;

    clearInterval(manualTimerInterval);
    // Don't clear session — user may need to verify after reopening
    // Session will be cleared on successful verify or expiry

    // Hide manual payment section
    const manualSection = document.getElementById('manualPaymentSection');
    if (manualSection) manualSection.style.display = 'none';
}

/**
 * Update wallet connection UI in the payment modal.
 */
function updateWalletUI(connected) {
    const connectBtn = document.getElementById('paymentConnectWallet');
    const walletInfo = document.getElementById('paymentWalletInfo');
    const walletAddr = document.getElementById('paymentWalletAddr');

    if (connected && pnpPublicKey) {
        if (connectBtn) connectBtn.style.display = 'none';
        if (walletInfo) walletInfo.style.display = 'flex';
        if (walletAddr) {
            const addr = pnpPublicKey.toString();
            walletAddr.textContent = addr.slice(0, 4) + '...' + addr.slice(-4);
        }
    } else {
        if (connectBtn) connectBtn.style.display = 'block';
        if (walletInfo) walletInfo.style.display = 'none';
    }
}

/**
 * Lock all payment buttons to prevent duplicate submissions.
 */
function lockPaymentButtons() {
    paymentProcessing = true;
    const ids = [
        'paymentConnectWallet', 'paySolSingle', 'paySolBundle',
        'payUsdcSingle', 'payUsdcBundle', 'payStripeSingle',
        'payStripeBundle', 'showManualPayment', 'verifyManualPayment'
    ];
    ids.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = true;
    });
}

/**
 * Unlock all payment buttons after a payment attempt completes.
 */
function unlockPaymentButtons() {
    paymentProcessing = false;
    const ids = [
        'paymentConnectWallet', 'paySolSingle', 'paySolBundle',
        'payUsdcSingle', 'payUsdcBundle', 'payStripeSingle',
        'payStripeBundle', 'showManualPayment', 'verifyManualPayment'
    ];
    ids.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = false;
    });
}

/**
 * Handle wallet connect from payment modal.
 */
async function handlePaymentConnect() {
    if (paymentProcessing) return;
    lockPaymentButtons();

    try {
        const addr = await connectWallet();
        if (addr) {
            updateWalletUI(true);
            // Sync nav bar wallet button
            if (typeof window._updateWalletBtn === 'function') window._updateWalletBtn();

            // Authenticate + check token balance
            await authenticateWallet();
            const access = await checkTokenBalance();

            if (access && access.has_access) {
                // Token Access Program member access granted
                const tierDisplay = {whale: 'Whale VIP', unlimited: 'Shark Elite', annual: 'Fish Starter'};
                showPaymentStatus('success', `Welcome back, ${tierDisplay[access.tier] || access.tier} member! Your access is active.`);
                setTimeout(() => {
                    closePaymentModal();
                    onPaymentComplete();
                }, 1500);
                return; // Keep buttons locked through redirect
            }

            // Try wallet-based restore (for previous crypto payments)
            if (typeof tryWalletRestore === 'function') {
                const restored = await tryWalletRestore();
                if (restored) {
                    showPaymentStatus('success', 'Access restored! Welcome back.');
                    setTimeout(() => {
                        closePaymentModal();
                        onPaymentComplete();
                    }, 1500);
                    return;
                }
            }
        }
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Handle SOL payment via Phantom.
 */
async function handleSolPayment(isBundle) {
    if (paymentProcessing) return;

    if (typeof solanaWeb3 === 'undefined') {
        showPaymentStatus('error', 'Solana library not loaded. Please refresh the page.');
        return;
    }

    if (!pnpWallet || !pnpPublicKey) {
        showPaymentStatus('error', 'Please connect your wallet first.');
        return;
    }

    lockPaymentButtons();
    const tool = isBundle ? 'bundle' : currentPaymentTool;
    const qty = getRunsQty();

    try {
        // Get merchant wallet + pricing from pricing endpoint
        const pricingRes = await fetch(`${PNP_API}/api/payments/pricing`);
        const pricing = await pricingRes.json();
        const baseAmount = isBundle ? pricing.sol.bundle : pricing.sol.per_tool;
        const amount = parseFloat((baseAmount * qty).toPrecision(10));
        const merchantAddress = pricing.sol && pricing.sol.merchant_wallet;

        showPaymentStatus('pending', `Initiating ${amount} SOL payment (${qty} run${qty > 1 ? 's' : ''})...`);

        if (!merchantAddress) {
            showPaymentStatus('error', 'Merchant wallet not configured. Please try again later.');
            return;
        }

        console.log('[Payment] Sending SOL directly to merchant:', merchantAddress);

        // Create Solana transaction — send directly to merchant wallet
        const { PublicKey, SystemProgram, Transaction: SolTx } = solanaWeb3;
        const recipient = new PublicKey(merchantAddress);
        const lamports = Math.round(amount * 1_000_000_000);

        const connection = new solanaWeb3.Connection(
            pricing.sol.rpc_url || 'https://api.mainnet-beta.solana.com', 'confirmed'
        );
        const { blockhash } = await connection.getLatestBlockhash();

        const tx = new SolTx({
            recentBlockhash: blockhash,
            feePayer: pnpPublicKey,
        });
        tx.add(
            SystemProgram.transfer({
                fromPubkey: pnpPublicKey,
                toPubkey: recipient,
                lamports: lamports,
            })
        );

        showPaymentStatus('pending', 'Please approve the transaction in Phantom...');

        const signed = await pnpWallet.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize());
        console.log('[Payment] TX signature:', signature);

        showPaymentStatus('pending', 'Transaction sent. Waiting for confirmation...');
        await connection.confirmTransaction(signature, 'confirmed');
        console.log('[Payment] TX confirmed on-chain');

        showPaymentStatus('pending', 'Confirmed! Verifying with backend...');

        // Verify directly with backend — no session wallet, no sweep needed
        const verifyPayload = {
            wallet: pnpPublicKey.toString(),
            tx_signature: signature,
            tool: tool,
            currency: 'SOL',
        };
        console.log('[Payment] Sending crypto verify:', verifyPayload);

        const verifyRes = await fetch(`${PNP_API}/api/payments/crypto/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(verifyPayload),
        });

        const verifyData = await verifyRes.json();
        console.log('[Payment] crypto verify response:', verifyRes.status, verifyData);

        if (verifyData.ok) {
            showPaymentStatus('success', 'Payment verified! Access granted.', { txSignature: signature });
            setTimeout(() => {
                closePaymentModal();
                onPaymentComplete();
            }, 2500);
            return; // Keep buttons locked through redirect
        } else if (verifyData.error === 'rate_limited') {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('verifyManualPayment') || document.getElementById('paySolSingle');
            showRateLimitWarning(retryBtn, statusEl);
        } else {
            showPaymentStatus('error', verifyData.detail || 'Verification failed');
        }

    } catch (e) {
        console.error('[Payment] SOL payment error:', e);
        const errMsg = e.message || '';
        if (errMsg.includes('User rejected')) {
            showPaymentStatus('error', 'Transaction cancelled.');
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('too many requests')) {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('paySolSingle');
            showRateLimitWarning(retryBtn, statusEl);
        } else {
            showPaymentStatus('error', `Payment failed: ${sanitizePaymentError(errMsg)}`);
        }
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Handle USDC payment via Phantom (auto-prompt, mirrors SOL flow).
 */
async function handleUsdcPayment(isBundle) {
    if (paymentProcessing) return;

    if (typeof solanaWeb3 === 'undefined') {
        showPaymentStatus('error', 'Solana library not loaded. Please refresh the page.');
        return;
    }

    if (!pnpWallet || !pnpPublicKey) {
        showPaymentStatus('error', 'Please connect your wallet first.');
        return;
    }

    lockPaymentButtons();
    const tool = isBundle ? 'bundle' : currentPaymentTool;
    const qty = getRunsQty();

    try {
        const { PublicKey, Transaction: SolTx } = solanaWeb3;

        // 1. Get mint + merchant ATA + price from pricing endpoint
        const pricingRes = await fetch(`${PNP_API}/api/payments/pricing`);
        const pricing = await pricingRes.json();

        const baseAmount = isBundle ? pricing.usdc.bundle : pricing.usdc.per_tool;
        const amount = baseAmount * qty;
        const usdcMint = pricing.usdc && pricing.usdc.mint;
        const merchantAta = pricing.usdc && pricing.usdc.merchant_ata;

        showPaymentStatus('pending', `Initiating ${amount} USDC payment (${qty} run${qty > 1 ? 's' : ''})...`);

        console.log('[USDC Debug] Pricing response:', JSON.stringify(pricing.usdc));
        console.log('[USDC Debug] Mint from backend:', usdcMint);
        console.log('[USDC Debug] Merchant ATA from backend:', merchantAta);

        if (!usdcMint || !merchantAta) {
            showPaymentStatus('error', 'USDC payment not available. Please try another method.');
            return;
        }

        const mintPubkey = new PublicKey(usdcMint);
        const merchantAtaPubkey = new PublicKey(merchantAta);

        // 2. Derive user's USDC ATA
        const [userAta] = await getAssociatedTokenAddress(pnpPublicKey, mintPubkey);
        console.log('[USDC Debug] User wallet:', pnpPublicKey.toString());
        console.log('[USDC Debug] Derived user ATA:', userAta.toString());

        // 3. Pre-check: does the user have a USDC account?
        const connection = new solanaWeb3.Connection(
            pricing.sol.rpc_url || 'https://api.mainnet-beta.solana.com', 'confirmed'
        );
        const userAtaInfo = await connection.getAccountInfo(userAta);
        console.log('[USDC Debug] User ATA account info:', userAtaInfo ? 'EXISTS' : 'NULL');
        if (!userAtaInfo) {
            showPaymentStatus('error', 'No USDC found in your wallet. Please fund your wallet with USDC first.');
            return;
        }

        // 4. Build TransferChecked instruction
        const usdcAmount = amount * 1_000_000; // USDC has 6 decimals
        const transferIx = createTransferCheckedInstruction(
            userAta, mintPubkey, merchantAtaPubkey, pnpPublicKey, usdcAmount, 6
        );

        // 5. Build, sign, send transaction
        const { blockhash } = await connection.getLatestBlockhash();
        const tx = new SolTx({
            recentBlockhash: blockhash,
            feePayer: pnpPublicKey,
        });
        tx.add(transferIx);

        showPaymentStatus('pending', 'Please approve the transaction in Phantom...');

        const signed = await pnpWallet.signTransaction(tx);
        const signature = await connection.sendRawTransaction(signed.serialize());
        console.log('[Payment] USDC TX signature:', signature);

        showPaymentStatus('pending', 'Transaction sent. Waiting for confirmation...');
        await connection.confirmTransaction(signature, 'confirmed');
        console.log('[Payment] USDC TX confirmed on-chain');

        showPaymentStatus('pending', 'Confirmed! Verifying with backend...');

        // 6. Verify with backend
        const verifyRes = await fetch(`${PNP_API}/api/payments/crypto/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                wallet: pnpPublicKey.toString(),
                tx_signature: signature,
                tool: tool,
                currency: 'USDC',
            }),
        });

        const verifyData = await verifyRes.json();
        console.log('[Payment] USDC verify response:', verifyRes.status, verifyData);

        if (verifyData.ok) {
            showPaymentStatus('success', 'Payment verified! Access granted.', { txSignature: signature });
            setTimeout(() => {
                closePaymentModal();
                onPaymentComplete();
            }, 2500);
            return; // Keep buttons locked through redirect
        } else if (verifyData.error === 'rate_limited') {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('payUsdcSingle');
            showRateLimitWarning(retryBtn, statusEl);
        } else {
            showPaymentStatus('error', verifyData.detail || 'Verification failed');
        }

    } catch (e) {
        console.error('[Payment] USDC payment error:', e);
        const errMsg = e.message || '';
        if (errMsg.includes('User rejected')) {
            showPaymentStatus('error', 'Transaction cancelled.');
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('too many requests')) {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('payUsdcSingle');
            showRateLimitWarning(retryBtn, statusEl);
        } else if (errMsg.includes('Insufficient') || errMsg.includes('insufficient')) {
            showPaymentStatus('error', 'Insufficient USDC balance.');
        } else {
            showPaymentStatus('error', `Payment failed: ${sanitizePaymentError(errMsg)}`);
        }
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Handle Stripe card payment.
 */
async function handleStripePayment(isBundle) {
    if (paymentProcessing) return;
    lockPaymentButtons();

    const tool = isBundle ? 'bundle' : currentPaymentTool;

    showPaymentStatus('pending', 'Creating checkout session...');

    try {
        const qty = getRunsQty();
        const res = await fetch(`${PNP_API}/api/payments/stripe/create-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: tool, quantity: qty }),
        });

        const data = await res.json();

        if (data.checkout_url) {
            // Store current tool so we know where to redirect back
            localStorage.setItem('pnp_pending_tool', tool);
            window.location.href = data.checkout_url;
            return; // Keep buttons locked through redirect
        } else {
            showPaymentStatus('error', data.detail || data.error || 'Failed to create checkout session');
        }

    } catch (e) {
        console.error('[Payment] Stripe error:', e);
        showPaymentStatus('error', `Stripe error: ${sanitizePaymentError(e.message)}`);
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Show manual payment section with session wallet and timer.
 */
function showManualPayment(tool, currency, amount, sessionWallet, expiresAt) {
    manualSessionWallet = sessionWallet;
    manualSessionExpiry = expiresAt;

    // Persist session to localStorage so it survives modal close/page refresh
    localStorage.setItem('pnp_manual_session', JSON.stringify({
        wallet: sessionWallet, expiry: expiresAt,
        tool: tool, amount: amount, currency: currency,
    }));

    const section = document.getElementById('manualPaymentSection');
    if (!section) return;

    section.style.display = 'block';

    const addrEl = document.getElementById('manualWalletAddress');
    const amountEl = document.getElementById('manualAmount');
    const timerEl = document.getElementById('manualTimer');

    if (addrEl) addrEl.textContent = sessionWallet;
    if (amountEl) amountEl.textContent = `${amount} ${currency}`;

    // Start countdown
    clearInterval(manualTimerInterval);
    updateManualTimer(timerEl);
    manualTimerInterval = setInterval(() => updateManualTimer(timerEl), 1000);
}

/**
 * Update manual payment countdown timer.
 */
function updateManualTimer(timerEl) {
    if (!manualSessionExpiry || !timerEl) return;

    const remaining = Math.max(0, manualSessionExpiry - Date.now() / 1000);

    if (remaining <= 0) {
        timerEl.textContent = 'EXPIRED';
        timerEl.style.color = '#f44336';
        clearInterval(manualTimerInterval);
        return;
    }

    const mins = Math.floor(remaining / 60);
    const secs = Math.floor(remaining % 60);
    timerEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    timerEl.style.color = remaining < 60 ? '#f44336' : remaining < 300 ? '#ff9800' : '#4CAF50';
}

/**
 * Verify manual payment with a transaction signature.
 */
async function verifyManualPayment() {
    if (paymentProcessing) return;

    const txInput = document.getElementById('manualTxSignature');
    const txSig = txInput ? txInput.value.trim() : '';

    if (!txSig) {
        showPaymentStatus('error', 'Please paste your transaction signature.');
        return;
    }

    if (!manualSessionWallet) {
        showPaymentStatus('error', 'No active payment session.');
        return;
    }

    lockPaymentButtons();
    showPaymentStatus('pending', 'Verifying payment...');

    try {
        const res = await fetch(`${PNP_API}/api/payments/crypto/verify-manual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                session_wallet: manualSessionWallet,
                tx_signature: txSig,
                tool: currentPaymentTool || 'bank',
            }),
        });

        const data = await res.json();

        if (data.ok) {
            // Clear session — payment complete
            localStorage.removeItem('pnp_manual_session');
            manualSessionWallet = null;
            manualSessionExpiry = null;
            showPaymentStatus('success', `Payment verified! ${data.amount_sol} SOL received.`);
            setTimeout(() => {
                closePaymentModal();
                onPaymentComplete();
            }, 1500);
            return; // Keep buttons locked through redirect
        } else if (data.error === 'rate_limited') {
            const statusEl = document.getElementById('paymentStatus');
            const verifyBtn = document.getElementById('verifyManualPayment');
            showRateLimitWarning(verifyBtn, statusEl);
        } else {
            showPaymentStatus('error', data.detail || 'Verification failed. Please check the transaction signature.');
        }

    } catch (e) {
        console.error('[Payment] Manual verify error:', e);
        showPaymentStatus('error', `Verification error: ${sanitizePaymentError(e.message)}`);
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Copy manual wallet address to clipboard.
 */
function copyManualAddress() {
    if (manualSessionWallet) {
        navigator.clipboard.writeText(manualSessionWallet).then(() => {
            const btn = document.getElementById('copyManualAddr');
            if (btn) {
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = original; }, 2000);
            }
        });
    }
}

/**
 * Sanitize error message for payment status display.
 */
function sanitizePaymentError(message) {
    if (!message || typeof message !== 'string') {
        return 'An unexpected error occurred. Please try again.';
    }
    if (/Traceback|File ".*", line \d+|at .*:\d+:\d+/i.test(message)) {
        return 'A server error occurred. Please try again or contact support.';
    }
    if (message.length > 200) {
        message = message.slice(0, 200) + '...';
    }
    return message;
}

/**
 * Show rate limit warning and disable the given button for 15 seconds with countdown.
 */
function showRateLimitWarning(buttonEl, statusEl) {
    if (statusEl) {
        statusEl.textContent = 'Solana RPC rate limited. Please wait 15 seconds...';
        statusEl.style.color = '#CEBA4C';
        statusEl.style.display = 'block';
    }
    if (buttonEl) {
        buttonEl.disabled = true;
        const originalText = buttonEl.textContent;
        let remaining = 15;
        const interval = setInterval(() => {
            remaining--;
            buttonEl.textContent = `Try Again (${remaining}s)`;
            if (remaining <= 0) {
                clearInterval(interval);
                buttonEl.disabled = false;
                buttonEl.textContent = originalText;
                if (statusEl) {
                    statusEl.textContent = 'Ready to retry.';
                    statusEl.style.color = '';
                }
            }
        }, 1000);
    }
}

/**
 * Show payment status message in the modal.
 * @param {string} type - 'success', 'error', or 'pending'
 * @param {string} message - Status text
 * @param {object} [opts] - Optional extras
 * @param {string} [opts.txSignature] - Solana TX signature for receipt link
 */
function showPaymentStatus(type, message, opts) {
    const statusEl = document.getElementById('paymentStatus');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = 'payment-status payment-status-' + type;
    statusEl.style.display = 'block';

    if (opts && opts.txSignature) {
        const link = document.createElement('a');
        link.href = `https://solscan.io/tx/${opts.txSignature}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'See Receipt';
        link.className = 'payment-receipt-link';
        statusEl.appendChild(document.createTextNode(' '));
        statusEl.appendChild(link);
    }
}

/**
 * Called after successful payment. Override in each page's JS.
 */
function onPaymentComplete() {
    // Default: reload to re-check access
    // Each page should override this to update their UI
    const paymentOverlay = document.getElementById('paymentOverlay');
    if (paymentOverlay) {
        paymentOverlay.style.display = 'none';
    }

    // Enable the submit button
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.disabled = false;
}

/**
 * Check if the current page's tool has access.
 * If not, show the payment overlay.
 */
async function checkToolAccess(tool) {
    const access = await checkAccess();

    if (access && access.valid) {
        // Always update counter with full runs_left data (all tools)
        updateRunsCounter(access.runs_left || {}, access.method || null);

        // Check if this specific tool is accessible
        if (access.tools && access.tools.includes(tool)) {
            const runsLeft = access.runs_left ? access.runs_left[tool] : 0;
            if (runsLeft === 'unlimited' || runsLeft > 0) {
                return true;
            }
        }
        return false;
    }

    // No access at all — show 0 runs
    updateRunsCounter({}, null);
    return false;
}

/**
 * Initialize payment modal event listeners.
 * Call this from DOMContentLoaded on each page.
 */
function initPaymentListeners() {
    // Close modal
    const closeBtn = document.getElementById('closePaymentModal');
    if (closeBtn) closeBtn.addEventListener('click', () => {
        if (manualSessionWallet && manualSessionExpiry > Date.now() / 1000) {
            if (!confirm('If you already sent SOL, make sure to copy your transaction signature before closing. Close anyway?')) {
                return;
            }
        }
        closePaymentModal();
    });

    // Connect wallet
    const connectBtn = document.getElementById('paymentConnectWallet');
    if (connectBtn) connectBtn.addEventListener('click', handlePaymentConnect);

    // Disconnect wallet
    const disconnectBtn = document.getElementById('paymentDisconnectWallet');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
            await disconnectWallet();
            updateWalletUI(false);
        });
    }

    // SOL/crypto payments — if radio buttons exist, respect the selection
    const solSingleBtn = document.getElementById('paySolSingle');
    if (solSingleBtn) {
        solSingleBtn.addEventListener('click', () => {
            const selected = document.querySelector('input[name="cryptoOption"]:checked');
            if (selected) {
                const val = selected.value;
                if (val === 'sol_single') handleSolPayment(false);
                else if (val === 'sol_bundle') handleSolPayment(true);
                else if (val === 'usdc_single') handleUsdcPayment(false);
                else if (val === 'usdc_bundle') handleUsdcPayment(true);
            } else {
                handleSolPayment(false);
            }
        });
    }

    const solBundleBtn = document.getElementById('paySolBundle');
    if (solBundleBtn) solBundleBtn.addEventListener('click', () => handleSolPayment(true));

    // USDC payments
    const usdcSingleBtn = document.getElementById('payUsdcSingle');
    if (usdcSingleBtn) usdcSingleBtn.addEventListener('click', () => handleUsdcPayment(false));

    const usdcBundleBtn = document.getElementById('payUsdcBundle');
    if (usdcBundleBtn) usdcBundleBtn.addEventListener('click', () => handleUsdcPayment(true));

    // Stripe payments — temporarily disabled (Coming Soon)
    const stripeSingleBtn = document.getElementById('payStripeSingle');
    if (stripeSingleBtn) {
        stripeSingleBtn.disabled = true;
        stripeSingleBtn.textContent = 'Card Payment — Coming Soon';
        stripeSingleBtn.style.opacity = '0.5';
        stripeSingleBtn.style.cursor = 'not-allowed';
    }

    const stripeBundleBtn = document.getElementById('payStripeBundle');
    if (stripeBundleBtn) {
        stripeBundleBtn.disabled = true;
        stripeBundleBtn.textContent = 'Card Payment — Coming Soon';
        stripeBundleBtn.style.opacity = '0.5';
        stripeBundleBtn.style.cursor = 'not-allowed';
    }

    // Manual payment
    const manualPayBtn = document.getElementById('showManualPayment');
    if (manualPayBtn) {
        manualPayBtn.addEventListener('click', () => {
            const tool = currentPaymentTool || 'bank';
            handleManualPaymentFlow(tool);
        });
    }

    const verifyManualBtn = document.getElementById('verifyManualPayment');
    if (verifyManualBtn) verifyManualBtn.addEventListener('click', verifyManualPayment);

    // Runs quantity selector
    const qtyInput = document.getElementById('runsQtyInput');
    const qtyUp = document.getElementById('runsQtyUp');
    const qtyDown = document.getElementById('runsQtyDown');
    if (qtyInput) {
        qtyInput.addEventListener('input', updateRunsQtyUI);
        qtyInput.addEventListener('change', () => {
            qtyInput.value = Math.max(1, Math.min(50, parseInt(qtyInput.value) || 1));
            updateRunsQtyUI();
        });
    }
    if (qtyUp) qtyUp.addEventListener('click', () => {
        if (qtyInput) { qtyInput.value = Math.min(50, (parseInt(qtyInput.value) || 1) + 1); updateRunsQtyUI(); }
    });
    if (qtyDown) qtyDown.addEventListener('click', () => {
        if (qtyInput) { qtyInput.value = Math.max(1, (parseInt(qtyInput.value) || 1) - 1); updateRunsQtyUI(); }
    });

    const copyAddrBtn = document.getElementById('copyManualAddr');
    if (copyAddrBtn) copyAddrBtn.addEventListener('click', copyManualAddress);

    // Close on backdrop click
    const modal = document.getElementById('paymentModal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                // Don't close if manual payment is active (user may have sent SOL)
                if (manualSessionWallet) return;
                closePaymentModal();
            }
        });
    }
}

// ==========================================
// Runs Counter Functions
// ==========================================

/**
 * Update the runs counter badge in the header.
 * @param {Object} runsLeft - e.g. { bank: 3, labeler: 'unlimited', tis: 0 }
 * @param {string|null} method - payment method (e.g. 'memecoin' for rewards members, 'crypto', 'stripe')
 */
function updateRunsCounter(runsLeft, method) {
    const counter = document.getElementById('runsCounter');
    if (!counter) return;

    const tool = counter.dataset.tool;
    const countEl = document.getElementById('runsCount');
    const labelEl = counter.querySelector('.runs-label');
    const tierEl = document.getElementById('runsTier');

    const runs = runsLeft[tool];

    // Store globally for other scripts
    window._pnpRunsLeft = runsLeft;
    window._pnpMethod = method;

    // Show the counter
    counter.classList.remove('d-none');

    // Remove state classes
    counter.classList.remove('runs-counter-depleted', 'runs-counter-unlimited');

    if (runs === 'unlimited') {
        countEl.textContent = '\u221E'; // infinity symbol
        labelEl.textContent = 'runs';
        counter.classList.add('runs-counter-unlimited');
    } else {
        const n = typeof runs === 'number' ? runs : 0;
        countEl.textContent = n;
        labelEl.textContent = n === 1 ? 'run' : 'runs';
        if (n === 0) {
            counter.classList.add('runs-counter-depleted');
        }
    }

    // Reward tier badge for token holders
    if (tierEl) {
        if (method === 'memecoin' && runsLeft[tool] !== undefined) {
            const r = runsLeft[tool];
            let tierName = '';
            if (r === 'unlimited') {
                tierName = 'Whale VIP';
            } else if (typeof r === 'number' && r > 10) {
                tierName = 'Shark Elite';
            } else if (typeof r === 'number' && r > 0) {
                tierName = 'Fish Starter';
            }
            if (tierName) {
                tierEl.textContent = tierName;
                tierEl.classList.remove('d-none');
            } else {
                tierEl.classList.add('d-none');
            }
        } else {
            tierEl.classList.add('d-none');
        }
    }

    // Build dynamic tooltip with per-tool breakdown
    _updateRunsTooltip(counter, runsLeft);

    // Enable gold theme toggle for reward token holders, disable for others
    if (method === 'memecoin' && typeof enableGoldTheme === 'function') {
        enableGoldTheme();
    } else if (typeof disableGoldTheme === 'function') {
        disableGoldTheme();
    }
}

/**
 * Build a dynamic tooltip showing runs breakdown for all tools.
 */
function _updateRunsTooltip(counter, runsLeft) {
    const toolNames = { bank: 'Bank Processor', labeler: 'Smart Labeler', tis: 'TIS', 'sales-tax': 'Sales Tax' };
    const hasAnyRuns = Object.keys(runsLeft).length > 0;

    if (!hasAnyRuns) {
        counter.setAttribute('data-tooltip',
            'No active runs. Pay on any tool page \u2014 single-tool or bundle (all 4 tools).');
        return;
    }

    const lines = [];
    for (const [t, name] of Object.entries(toolNames)) {
        const r = runsLeft[t];
        if (r === 'unlimited') {
            lines.push(name + ': unlimited');
        } else if (typeof r === 'number') {
            lines.push(name + ': ' + r + (r === 1 ? ' run' : ' runs'));
        } else {
            lines.push(name + ': 0 runs');
        }
    }

    counter.setAttribute('data-tooltip',
        lines.join('  |  ') +
        '\n\nBuy single-tool or bundle (all 4) from any tool page.');
}

/**
 * Decrement the local runs counter by 1 and re-render.
 * @returns {number|string} new runs count for current tool
 */
function decrementRunsCounter() {
    const counter = document.getElementById('runsCounter');
    if (!counter) return 0;

    const tool = counter.dataset.tool;
    const runsLeft = window._pnpRunsLeft || {};
    const current = runsLeft[tool];

    // Don't decrement unlimited
    if (current === 'unlimited') return 'unlimited';

    const newCount = Math.max(0, (typeof current === 'number' ? current : 1) - 1);
    runsLeft[tool] = newCount;
    window._pnpRunsLeft = runsLeft;

    updateRunsCounter(runsLeft, window._pnpMethod);
    return newCount;
}

/**
 * Re-lock the tool by showing the payment overlay and disabling the form.
 */
function lockToolAfterDepletion() {
    const overlay = document.getElementById('paymentOverlay');
    if (overlay) overlay.classList.remove('d-none');
    // Also reset overlay inline display in case it was hidden with style.display
    if (overlay) overlay.style.display = '';

    // Lock the form
    const formIds = ['uploadForm', 'labelerForm', 'tisForm'];
    formIds.forEach(id => {
        const f = document.getElementById(id);
        if (f) f.classList.add('payment-locked');
    });
}

/**
 * Update the "Process Another" / "Start Over" button text when runs are depleted.
 * @param {boolean} depleted - true if no runs remain
 */
function updateProcessAnotherButton(depleted) {
    // Bank processor
    const processAnotherBtn = document.getElementById('processAnotherBtn');
    if (processAnotherBtn) {
        if (depleted) {
            processAnotherBtn.textContent = 'Pay to Process Another';
            processAnotherBtn.classList.add('process-another-locked');
        } else {
            processAnotherBtn.textContent = 'Process Another';
            processAnotherBtn.classList.remove('process-another-locked');
        }
    }

    // Labeler
    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) {
        if (depleted) {
            resetBtn.textContent = 'Pay to Process Another';
            resetBtn.classList.add('process-another-locked');
        } else {
            // Restore original text based on page context
            const isLabeler = document.getElementById('labelerForm');
            const isTis = document.getElementById('tisForm');
            resetBtn.textContent = (isLabeler || isTis) ? 'Start Over' : 'Process Another';
            resetBtn.classList.remove('process-another-locked');
        }
    }
}

/**
 * Start manual payment flow (creates session wallet).
 */
async function handleManualPaymentFlow(tool) {
    if (paymentProcessing) return;

    // Check for existing session in localStorage
    const saved = localStorage.getItem('pnp_manual_session');
    if (saved) {
        try {
            const session = JSON.parse(saved);
            if (session.expiry > Date.now() / 1000 && session.tool === tool) {
                showManualPayment(tool, session.currency, session.amount, session.wallet, session.expiry);
                showPaymentStatus('pending', `Send ${session.amount} ${session.currency} to the address below, then paste the transaction signature.`);
                return;
            }
        } catch (e) { /* ignore parse errors */ }
        localStorage.removeItem('pnp_manual_session');
    }

    lockPaymentButtons();

    showPaymentStatus('pending', 'Creating payment session...');

    try {
        const res = await fetch(`${PNP_API}/api/payments/crypto/prepare-manual`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool: tool, currency: 'SOL' }),
        });

        const data = await res.json();

        if (data.ok) {
            showManualPayment(tool, 'SOL', data.amount, data.session_wallet, data.expires_at);
            showPaymentStatus('pending', `Send ${data.amount_display} to the address below, then paste the transaction signature.`);
        } else {
            showPaymentStatus('error', data.detail || 'Failed to create session');
        }
    } catch (e) {
        showPaymentStatus('error', `Error: ${sanitizePaymentError(e.message)}`);
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Verify that a rewards member still holds the required tokens
 * before allowing a tool run. Non-rewards users skip this check.
 * @param {string} tool - 'bank', 'labeler', or 'tis'
 * @returns {boolean} true if run is allowed
 */
async function verifyRunAccess(tool) {
    if (window._pnpMethod !== 'memecoin') return true;

    try {
        var res = await fetch(PNP_API + '/api/payments/token/verify-run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ tool: tool })
        });
        var data = await res.json();
        if (data.error === 'rate_limited') {
            showPaymentStatus('error', 'Solana RPC rate limited. Please wait 15 seconds and try again.');
            return false;
        }
        return !!data.verified;
    } catch (e) {
        console.error('[Payment] verify-run error:', e);
        return false;
    }
}
