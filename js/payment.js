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
let paymentModalTrigger = null;
let manualCurrency = 'SOL';

// Payment flow analytics — structured logging for debugging drop-offs
function trackPaymentStep(step, data) {
    const entry = { step, tool: currentPaymentTool, timestamp: new Date().toISOString(), ...data };
    console.log('[PaymentFlow]', step, entry);
    // Future: send to /api/analytics/payment-step for server-side tracking
}

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

    // Update crypto price display
    updatePaymentPrice();

    // Update Stripe prices (still uses radio buttons)
    if (!cachedPricing) return;
    const p = cachedPricing;
    document.querySelectorAll('.payment-option').forEach(opt => {
        const radio = opt.querySelector('input[type="radio"]');
        const priceSpan = opt.querySelector('.price');
        if (!radio || !priceSpan) return;
        const v = radio.value;
        let base = 0;
        if (v === 'single') { base = p.stripe.per_tool; }
        else if (v === 'bundle') { base = p.stripe.bundle; }
        if (base) {
            const total = parseFloat((base * qty).toPrecision(10));
            priceSpan.textContent = `$${total}`;
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
    trackPaymentStep('modal_opened', { tool });

    // Update tool name in modal
    const toolNames = { bank: 'Bank Processor', labeler: 'Smart Labeler', tis: 'TIS Generator', 'sales-tax': 'Sales Tax Helper' };
    const toolDisplayName = toolNames[tool] || tool;
    const toolNameEl = modal.querySelector('.payment-tool-name');
    if (toolNameEl) {
        toolNameEl.textContent = toolDisplayName;
    }

    // Update plan dropdown with actual tool name
    const planSelect = document.getElementById('paymentPlan');
    if (planSelect) {
        planSelect.innerHTML = `<option value="single">${toolDisplayName}</option><option value="bundle">All 4 Tools</option>`;
    }

    paymentModalTrigger = document.activeElement;
    modal.style.display = 'flex';
    paymentModalOpen = true;

    // Focus the close button for keyboard users
    const closeBtn = modal.querySelector('#closePaymentModal');
    if (closeBtn) setTimeout(() => closeBtn.focus(), 50);

    // Populate currency dropdown
    populatePaymentDropdowns();

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

    // Restore focus to the element that opened the modal
    if (paymentModalTrigger) {
        paymentModalTrigger.focus();
        paymentModalTrigger = null;
    }
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
        'paymentConnectWallet', 'payNowBtn', 'paySolBundle',
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
        'paymentConnectWallet', 'payNowBtn', 'paySolBundle',
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

            // Check token balance (includes wallet signature verification)
            showPaymentStatus('pending', 'Verifying rewards tier...');
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

            // No rewards access — clear status and check if they qualify
            showPaymentStatus('', '');
            // (wallet restore happens on page load via wallet-btn.js, not here)
            checkAndPromptRewardsSignature();
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
    trackPaymentStep('payment_started', { currency: 'SOL', isBundle, qty });

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
        trackPaymentStep('sol_tx_sent', { signature });

        showPaymentStatus('pending', 'Transaction sent — confirming on Solana... <a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener" style="color:#CEBA4C;">View on Solscan</a>');
        try {
            await Promise.race([
                connection.confirmTransaction(signature, 'confirmed'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Confirmation timeout')), 60000))
            ]);
        } catch (e) {
            if (e.message === 'Confirmation timeout') {
                showPaymentStatus('pending', 'Still confirming... <a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener" style="color:#CEBA4C;">Check Solscan</a>');
                await connection.confirmTransaction(signature, 'confirmed');
            } else { throw e; }
        }
        console.log('[Payment] TX confirmed on-chain');
        trackPaymentStep('sol_tx_confirmed', { signature });

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
            trackPaymentStep('sol_payment_success', { signature, runs: verifyData.runs_granted });
            showPaymentStatus('success', 'Payment verified! Access granted.', { txSignature: signature });
            setTimeout(() => {
                closePaymentModal();
                onPaymentComplete();
            }, 2500);
            return; // Keep buttons locked through redirect
        } else if (verifyData.error === 'rate_limited') {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('verifyManualPayment') || document.getElementById('payNowBtn');
            showRateLimitWarning(retryBtn, statusEl);
        } else {
            showPaymentStatus('error', verifyData.detail || 'Verification failed');
        }

    } catch (e) {
        console.error('[Payment] SOL payment error:', e);
        trackPaymentStep('sol_payment_error', { error: e.message });
        const errMsg = e.message || '';
        if (errMsg.includes('User rejected')) {
            showPaymentStatus('error', 'Transaction cancelled.');
        } else if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate limit') || errMsg.toLowerCase().includes('too many requests')) {
            const statusEl = document.getElementById('paymentStatus');
            const retryBtn = document.getElementById('payNowBtn');
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
async function handleSplPayment(tokenKey, isBundle) {
    if (paymentProcessing) return;
    trackPaymentStep('payment_started', { currency: tokenKey.toUpperCase(), isBundle, qty: getRunsQty() });

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

        const tokenConfig = pricing[tokenKey];
        if (!tokenConfig || !tokenConfig.mint || !tokenConfig.merchant_ata) {
            showPaymentStatus('error', `${tokenKey.toUpperCase()} payment not available. Please try another method.`);
            return;
        }

        const baseAmount = isBundle ? tokenConfig.bundle : tokenConfig.per_tool;
        const amount = baseAmount * qty;
        const symbol = tokenConfig.symbol || tokenKey.toUpperCase();
        const decimals = tokenConfig.decimals || 6;

        showPaymentStatus('pending', `Initiating ${amount.toLocaleString()} ${symbol} payment (${qty} run${qty > 1 ? 's' : ''})...`);

        const mintPubkey = new PublicKey(tokenConfig.mint);
        const merchantAtaPubkey = new PublicKey(tokenConfig.merchant_ata);

        const [userAta] = await getAssociatedTokenAddress(pnpPublicKey, mintPubkey);

        const connection = new solanaWeb3.Connection(
            pricing.sol.rpc_url || 'https://api.mainnet-beta.solana.com', 'confirmed'
        );
        const userAtaInfo = await connection.getAccountInfo(userAta);
        if (!userAtaInfo) {
            showPaymentStatus('error', `No ${symbol} found in your wallet.`);
            return;
        }

        const tokenAmount = amount * (10 ** decimals);
        const transferIx = createTransferCheckedInstruction(
            userAta, mintPubkey, merchantAtaPubkey, pnpPublicKey, tokenAmount, decimals
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
        console.log(`[Payment] ${symbol} TX signature:`, signature);
        trackPaymentStep('spl_tx_sent', { currency: symbol, signature });

        showPaymentStatus('pending', 'Transaction sent — confirming on Solana... <a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener" style="color:#CEBA4C;">View on Solscan</a>');
        try {
            await Promise.race([
                connection.confirmTransaction(signature, 'confirmed'),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Confirmation timeout')), 60000))
            ]);
        } catch (e) {
            if (e.message === 'Confirmation timeout') {
                showPaymentStatus('pending', 'Still confirming... <a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener" style="color:#CEBA4C;">Check Solscan</a>');
                await connection.confirmTransaction(signature, 'confirmed');
            } else { throw e; }
        }
        console.log(`[Payment] ${symbol} TX confirmed on-chain`);
        trackPaymentStep('spl_tx_confirmed', { currency: symbol, signature });

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
                currency: symbol,
            }),
        });

        const verifyData = await verifyRes.json();

        if (verifyData.ok) {
            trackPaymentStep('spl_payment_success', { currency: symbol, signature, runs: verifyData.runs_granted });
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
        console.error(`[Payment] ${symbol} payment error:`, e);
        trackPaymentStep('spl_payment_error', { currency: symbol, error: e.message });
        const errMsg = e.message || '';
        if (errMsg.includes('User rejected')) {
            showPaymentStatus('error', 'Transaction cancelled.');
        } else if (errMsg.includes('Insufficient') || errMsg.includes('insufficient')) {
            showPaymentStatus('error', `Insufficient ${symbol} balance.`);
        } else {
            showPaymentStatus('error', `Payment failed: ${sanitizePaymentError(errMsg)}`);
        }
    } finally {
        unlockPaymentButtons();
    }
}

/**
 * Populate currency dropdown from pricing API and set up price updates.
 */
async function populatePaymentDropdowns() {
    const currencySelect = document.getElementById('paymentCurrency');
    const planSelect = document.getElementById('paymentPlan');
    if (!currencySelect) return;

    try {
        if (!cachedPricing) {
            const res = await fetch(`${PNP_API}/api/payments/pricing`);
            cachedPricing = await res.json();
        }
        const pricing = cachedPricing;
        const skipKeys = new Set(['sol', 'stripe', 'tools', 'memecoin_tiers']);

        // Token icon URLs
        const tokenIcons = {
            sol: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
            usdc: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
            pigeon: 'https://941pigeon.fun/logo-941.png',
        };

        // Keep SOL as first option, add SPL tokens
        let options = '<option value="sol">SOL</option>';
        for (const [key, config] of Object.entries(pricing)) {
            if (skipKeys.has(key) || !config.mint) continue;
            const symbol = config.symbol || key.toUpperCase();
            options += `<option value="${key}">${symbol}</option>`;
        }
        currencySelect.innerHTML = options;

        // Add icon element next to dropdown if not already there
        let iconEl = document.getElementById('currencyIcon');
        if (!iconEl) {
            // Wrap select in a row with the icon
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;align-items:center;gap:0.5rem;';
            iconEl = document.createElement('img');
            iconEl.id = 'currencyIcon';
            iconEl.style.cssText = 'width:24px;height:24px;border-radius:50%;flex-shrink:0;';
            iconEl.alt = '';
            currencySelect.parentElement.insertBefore(wrapper, currencySelect);
            wrapper.appendChild(iconEl);
            wrapper.appendChild(currencySelect);
        }

        function updateCurrencyIcon() {
            const val = currencySelect.value;
            const iconUrl = tokenIcons[val] || '';
            if (iconEl && iconUrl) {
                iconEl.src = iconUrl;
                iconEl.onerror = function() { if (val === 'pigeon') { this.src = '/assets/pigeonhouse-logo.jpg'; this.onerror = null; } else { this.style.display = 'none'; } };
                iconEl.style.display = '';
            } else if (iconEl) {
                iconEl.style.display = 'none';
            }
        }

        // Attach change listeners
        currencySelect.addEventListener('change', () => { updatePaymentPrice(); updateCurrencyIcon(); });
        if (planSelect) planSelect.addEventListener('change', updatePaymentPrice);

        updatePaymentPrice();
        updateCurrencyIcon();
    } catch (e) {
        console.debug('[PnP] Failed to populate payment dropdowns:', e);
    }
}

/**
 * Update the price display based on selected currency, plan, and quantity.
 */
function updatePaymentPrice() {
    const display = document.getElementById('paymentPriceDisplay');
    if (!display || !cachedPricing) return;

    const currency = document.getElementById('paymentCurrency')?.value || 'sol';
    const plan = document.getElementById('paymentPlan')?.value || 'single';
    const qty = getRunsQty();

    const pricing = cachedPricing[currency] || cachedPricing.sol;
    const basePrice = plan === 'bundle' ? pricing.bundle : pricing.per_tool;
    const total = basePrice * qty;
    const symbol = pricing.symbol || currency.toUpperCase();

    display.textContent = `Price: ${total.toLocaleString()} ${symbol}`;
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
        // Clear expired session
        manualSessionWallet = null;
        manualSessionExpiry = null;
        localStorage.removeItem('pnp_manual_session');
        showPaymentStatus('error', 'Session expired. Click "Manual Payment" again for a fresh address.');
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

    if (manualSessionExpiry && manualSessionExpiry < Date.now() / 1000) {
        showPaymentStatus('error', 'Session expired. Click "Manual Payment" again for a fresh address.');
        manualSessionWallet = null;
        manualSessionExpiry = null;
        localStorage.removeItem('pnp_manual_session');
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
                currency: manualCurrency || 'SOL',
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
        copyToClipboard(manualSessionWallet).then(function(ok) {
            const btn = document.getElementById('copyManualAddr');
            if (btn) {
                const original = btn.textContent;
                btn.textContent = ok ? 'Copied!' : 'Failed';
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
    // Flag to show callout when runs counter updates
    window._pnpShowPaymentCallout = true;

    // Default: reload to re-check access
    // Each page should override this to update their UI
    const paymentOverlay = document.getElementById('paymentOverlay');
    if (paymentOverlay) {
        paymentOverlay.style.display = 'none';
    }

    // Enable the submit button
    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.disabled = false;

    // Re-check access to update runs counter (triggers callout)
    const tool = document.getElementById('runsCounter')?.dataset?.tool || 'bank';
    checkToolAccess(tool);
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

    // Escape key to close modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && paymentModalOpen) {
            closePaymentModal();
        }
    });

    // Focus trap within modal
    const paymentModal = document.getElementById('paymentModal');
    if (paymentModal) {
        paymentModal.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab') return;
            const focusable = paymentModal.querySelectorAll('button:not([disabled]):not([style*="display: none"]), input:not([disabled]), a[href], select:not([disabled]), [tabindex]:not([tabindex="-1"])');
            if (!focusable.length) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });
    }

    // Connect wallet
    const connectBtn = document.getElementById('paymentConnectWallet');
    if (connectBtn) connectBtn.addEventListener('click', handlePaymentConnect);

    // Click runs counter to buy more runs
    const runsCounter = document.getElementById('runsCounter');
    if (runsCounter) {
        runsCounter.addEventListener('click', () => {
            const tool = runsCounter.dataset?.tool || 'bank';
            showPaymentModal(tool);
        });
    }

    // Disconnect wallet
    const disconnectBtn = document.getElementById('paymentDisconnectWallet');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
            await disconnectWallet();
            updateWalletUI(false);
            // Sync nav bar wallet button
            if (typeof window._updateWalletBtn === 'function') window._updateWalletBtn();
            // Hide runs counter
            const counter = document.getElementById('runsCounter');
            if (counter) counter.classList.add('d-none');
            // Update runs counter to show no access
            if (typeof updateRunsCounter === 'function') updateRunsCounter({}, null);
        });
    }

    // SOL/crypto payments — if radio buttons exist, respect the selection
    // Pay Now button — reads from currency + plan dropdowns
    const payNowBtn = document.getElementById('payNowBtn');
    if (payNowBtn) {
        payNowBtn.addEventListener('click', () => {
            const currency = document.getElementById('paymentCurrency')?.value || 'sol';
            const plan = document.getElementById('paymentPlan')?.value || 'single';
            const isBundle = plan === 'bundle';

            if (currency === 'sol') handleSolPayment(isBundle);
            else handleSplPayment(currency, isBundle);
        });
    }

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

    // Show post-payment callout if flagged
    if (window._pnpShowPaymentCallout) {
        window._pnpShowPaymentCallout = false;
        showRunsCallout(counter);
    }

    // Enable gold theme toggle for reward token holders, disable for others
    if (method === 'memecoin' && typeof enableGoldTheme === 'function') {
        enableGoldTheme();
    } else if (typeof disableGoldTheme === 'function') {
        disableGoldTheme();
    }
}

/**
 * Show a callout bubble near the runs counter after successful payment.
 */
function showRunsCallout(counter) {
    // Remove any existing callout
    const old = counter.querySelector('.runs-callout');
    if (old) old.remove();

    const callout = document.createElement('div');
    callout.className = 'runs-callout';
    callout.innerHTML = '<div class="callout-title">Payment confirmed</div>' +
        'Your runs are tracked here. Click anytime to buy more.' +
        '<div class="callout-dismiss">Click to dismiss</div>';
    counter.appendChild(callout);

    // Pulse the counter border
    counter.style.borderColor = 'rgba(206, 186, 76, 0.7)';
    counter.style.boxShadow = '0 0 16px rgba(206, 186, 76, 0.2)';

    function dismiss() {
        callout.classList.add('runs-callout-exit');
        counter.style.borderColor = '';
        counter.style.boxShadow = '';
        setTimeout(() => callout.remove(), 300);
    }

    callout.addEventListener('click', dismiss);
    // Auto-dismiss after 6 seconds
    setTimeout(dismiss, 6000);
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
        '\n\nClick to buy more runs.');
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

    // Read currency and plan from dropdowns
    const currencySelect = document.getElementById('paymentCurrency');
    const planSelect = document.getElementById('paymentPlan');
    let currency = currencySelect ? currencySelect.value.toUpperCase() : 'SOL';
    const isBundle = planSelect ? planSelect.value === 'bundle' : false;
    if (isBundle) tool = 'bundle';
    manualCurrency = currency;
    trackPaymentStep('manual_payment_started', { currency, tool });

    // Check for existing session in localStorage
    const saved = localStorage.getItem('pnp_manual_session');
    if (saved) {
        try {
            const session = JSON.parse(saved);
            if (session.expiry > Date.now() / 1000 && session.tool === tool && session.currency === currency) {
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
            body: JSON.stringify({ tool: tool, currency: currency }),
        });

        const data = await res.json();

        if (data.ok) {
            const walletAddr = data.wallet_address || data.session_wallet;
            showManualPayment(tool, currency, data.amount, walletAddr, data.expires_at);
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
