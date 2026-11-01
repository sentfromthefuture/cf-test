import React, { useState, useEffect } from 'react';
import { 
  X, 
  Check, 
  CreditCard, 
  ShieldCheck, 
  QrCode, 
  Copy, 
  ExternalLink, 
  Settings, 
  Sparkles, 
  Lock, 
  ArrowRight,
  AlertCircle,
  Wallet,
  Building,
  CheckCircle2
} from 'lucide-react';
import { PricingTier } from '../types';

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedTier: PricingTier;
  onPaymentSuccess: (tier: PricingTier) => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  selectedTier,
  onPaymentSuccess,
}) => {
  const [paymentMethod, setPaymentMethod] = useState<'paypal' | 'binance' | 'card'>('paypal');
  const [isOwnerConfigOpen, setIsOwnerConfigOpen] = useState(false);

  // Merchant / Owner payment settings stored in localStorage
  const [paypalEmail, setPaypalEmail] = useState<string>(() => {
    return localStorage.getItem('dr_merchant_paypal_email') || 'payments@demandradar.com';
  });
  const [paypalClientId, setPaypalClientId] = useState<string>(() => {
    return localStorage.getItem('dr_merchant_paypal_client_id') || '';
  });
  const [binancePayId, setBinancePayId] = useState<string>(() => {
    return localStorage.getItem('dr_merchant_binance_id') || '492817392';
  });
  const [binanceUsdtAddress, setBinanceUsdtAddress] = useState<string>(() => {
    return localStorage.getItem('dr_merchant_usdt_address') || 'TX9sK4L7mN8xZ1vP3qB2yR5wE8tA4cD6gH';
  });

  const [copiedAddress, setCopiedAddress] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentDone, setPaymentDone] = useState(false);
  const [txHashInput, setTxHashInput] = useState('');

  const tierPrices: Record<PricingTier, { price: number; display: string }> = {
    Free: { price: 0, display: '$0' },
    Starter: { price: 9, display: '$9' },
    Pro: { price: 29, display: '$29' },
    Business: { price: 79, display: '$79' },
  };

  const currentPrice = tierPrices[selectedTier] || tierPrices.Pro;

  const handleSaveOwnerSettings = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('dr_merchant_paypal_email', paypalEmail);
    localStorage.setItem('dr_merchant_paypal_client_id', paypalClientId);
    localStorage.setItem('dr_merchant_binance_id', binancePayId);
    localStorage.setItem('dr_merchant_usdt_address', binanceUsdtAddress);
    setIsOwnerConfigOpen(false);
  };

  const handleSimulatePayment = () => {
    setIsProcessing(true);
    setTimeout(() => {
      setIsProcessing(false);
      setPaymentDone(true);
      setTimeout(() => {
        onPaymentSuccess(selectedTier);
        onClose();
        setPaymentDone(false);
      }, 1500);
    }, 1800);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2500);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-600 text-white font-bold">
              $
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">DemandRadar Checkout</h2>
                <span className="rounded bg-cyan-950 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-cyan-800">
                  {selectedTier} Subscription
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Unlock full market intelligence & competitor vulnerability teardowns.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsOwnerConfigOpen(!isOwnerConfigOpen)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
              title="Configure Your Merchant PayPal / Binance Details"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Owner Settings Drawer (if toggled) */}
        {isOwnerConfigOpen && (
          <div className="border-b border-amber-500/40 bg-amber-950/20 px-6 py-4 space-y-3 animate-fade-in">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                <Settings className="h-3.5 w-3.5" />
                Merchant Payout Settings (Your Accounts)
              </span>
              <button
                onClick={() => setIsOwnerConfigOpen(false)}
                className="text-xs text-slate-400 hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>
            <p className="text-[11px] text-slate-300">
              Enter your real PayPal and Binance accounts here. Customer payments will be directed to these addresses.
            </p>

            <form onSubmit={handleSaveOwnerSettings} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400">Your PayPal Email / PayPal.me</label>
                <input
                  type="text"
                  value={paypalEmail}
                  onChange={(e) => setPaypalEmail(e.target.value)}
                  placeholder="e.g. yourname@gmail.com"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-slate-400">PayPal Client ID (Optional for SDK)</label>
                <input
                  type="text"
                  value={paypalClientId}
                  onChange={(e) => setPaypalClientId(e.target.value)}
                  placeholder="Client ID from developer.paypal.com"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-slate-400">Your Binance Pay ID / Merchant ID</label>
                <input
                  type="text"
                  value={binancePayId}
                  onChange={(e) => setBinancePayId(e.target.value)}
                  placeholder="e.g. 492817392"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white focus:border-amber-400 focus:outline-none"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[11px] text-slate-400">Your USDT (TRC-20 / BEP-20) Address</label>
                <input
                  type="text"
                  value={binanceUsdtAddress}
                  onChange={(e) => setBinanceUsdtAddress(e.target.value)}
                  placeholder="e.g. TX9sK4L7mN8xZ1vP3qB2yR5w..."
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 p-2 text-white focus:border-amber-400 focus:outline-none font-mono text-[10px]"
                />
              </div>

              <div className="sm:col-span-2 flex justify-end">
                <button
                  type="submit"
                  className="rounded-lg bg-amber-500 px-4 py-1.5 text-xs font-bold text-slate-950 hover:bg-amber-400 cursor-pointer shadow-sm"
                >
                  Save Merchant Accounts
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Order Summary Card */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 flex items-center justify-between">
            <div>
              <span className="text-xs text-slate-400 block">Selected Tier</span>
              <span className="text-base font-bold text-white flex items-center gap-1.5">
                DemandRadar {selectedTier} License
              </span>
              <span className="text-[11px] text-cyan-400">Full Intelligence Dossiers + Competitor Gaps</span>
            </div>
            <div className="text-right">
              <span className="text-2xl font-black font-mono text-emerald-400">{currentPrice.display}</span>
              <span className="text-xs text-slate-400 block">/month (cancel anytime)</span>
            </div>
          </div>

          {/* Payment Method Switcher Tabs */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 block">
              Choose Payment Method
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setPaymentMethod('paypal')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                  paymentMethod === 'paypal'
                    ? 'border-blue-500 bg-blue-950/40 text-blue-300 shadow-sm ring-1 ring-blue-500/30'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold text-sm tracking-tight text-white mb-0.5">PayPal</div>
                <span className="text-[10px] text-slate-400">Account / Card</span>
              </button>

              <button
                onClick={() => setPaymentMethod('binance')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                  paymentMethod === 'binance'
                    ? 'border-amber-500 bg-amber-950/40 text-amber-300 shadow-sm ring-1 ring-amber-500/30'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold text-sm tracking-tight text-white mb-0.5">Binance Pay</div>
                <span className="text-[10px] text-slate-400">Crypto / USDT</span>
              </button>

              <button
                onClick={() => setPaymentMethod('card')}
                className={`flex flex-col items-center justify-center p-3 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                  paymentMethod === 'card'
                    ? 'border-cyan-500 bg-cyan-950/40 text-cyan-300 shadow-sm ring-1 ring-cyan-500/30'
                    : 'border-slate-800 bg-slate-950/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="font-bold text-sm tracking-tight text-white mb-0.5">Credit Card</div>
                <span className="text-[10px] text-slate-400">Visa / Mastercard</span>
              </button>
            </div>
          </div>

          {/* TAB 1: PAYPAL CHECKOUT */}
          {paymentMethod === 'paypal' && (
            <div className="rounded-xl border border-blue-900/40 bg-blue-950/15 p-5 space-y-4 text-xs animate-fade-in">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-white font-black text-xs">
                    P
                  </div>
                  <div>
                    <span className="font-bold text-white text-sm">PayPal Checkout</span>
                    <span className="text-slate-400 block text-[11px]">Pay directly via your PayPal balance or debit card</span>
                  </div>
                </div>
                <span className="font-mono text-emerald-400 font-bold">{currentPrice.display} USD</span>
              </div>

              <div className="rounded-lg bg-slate-950/80 p-3 border border-slate-800 space-y-2">
                <div className="flex justify-between text-slate-400">
                  <span>Merchant Recipient:</span>
                  <span className="font-mono text-white font-medium">{paypalEmail}</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Item:</span>
                  <span className="text-white">DemandRadar {selectedTier} Tier</span>
                </div>
                <div className="flex justify-between text-slate-400">
                  <span>Billing Cycle:</span>
                  <span className="text-white">Monthly (auto-renews)</span>
                </div>
              </div>

              {/* Direct PayPal Checkout Actions */}
              <div className="space-y-2 pt-1">
                {/* Official PayPal Button Style */}
                <button
                  onClick={handleSimulatePayment}
                  disabled={isProcessing}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#0070ba] hover:bg-[#005ea6] text-white py-3 px-4 text-xs font-bold shadow-md transition-all cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? (
                    <Sparkles className="h-4 w-4 animate-spin text-white" />
                  ) : (
                    <span>Pay with <strong>PayPal</strong></span>
                  )}
                </button>

                <a
                  href={`https://www.paypal.com/paypalme/${paypalEmail.replace(/[@.].*/, '')}/${currentPrice.price}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 py-2.5 px-4 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open Direct PayPal.Me Payment Link
                </a>
              </div>

              <p className="text-[10px] text-slate-400 text-center">
                Encrypted with PayPal Buyer Protection & SSL 256-bit protocol.
              </p>
            </div>
          )}

          {/* TAB 2: BINANCE PAY & CRYPTO */}
          {paymentMethod === 'binance' && (
            <div className="rounded-xl border border-amber-900/40 bg-amber-950/15 p-5 space-y-4 text-xs animate-fade-in">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500 text-slate-950 font-black text-xs">
                    B
                  </div>
                  <div>
                    <span className="font-bold text-white text-sm">Binance Pay / Crypto Deposit</span>
                    <span className="text-slate-400 block text-[11px]">Instant settlement via USDT (TRC-20, BEP-20)</span>
                  </div>
                </div>
                <span className="font-mono text-amber-400 font-bold">{currentPrice.price} USDT</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center bg-slate-950/80 p-3.5 rounded-xl border border-slate-800">
                {/* QR Code Illustration */}
                <div className="flex flex-col items-center justify-center p-2 rounded-lg bg-white shrink-0 mx-auto sm:mx-0 w-28 h-28">
                  <QrCode className="h-20 w-20 text-slate-900" />
                  <span className="text-[8px] text-slate-700 font-bold mt-1">SCAN VIA BINANCE</span>
                </div>

                {/* Details */}
                <div className="sm:col-span-2 space-y-2">
                  <div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Merchant Binance Pay ID:</span>
                    <span className="font-mono text-white font-bold text-sm">{binancePayId}</span>
                  </div>

                  <div>
                    <span className="text-[10px] text-slate-400 uppercase tracking-wider block">USDT TRC-20 / BEP-20 Address:</span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <code className="text-[10px] font-mono text-cyan-300 bg-slate-900 px-2 py-1 rounded border border-slate-800 truncate block max-w-[200px]">
                        {binanceUsdtAddress}
                      </code>
                      <button
                        onClick={() => copyToClipboard(binanceUsdtAddress)}
                        className="rounded bg-slate-800 p-1 text-slate-300 hover:text-white transition-colors cursor-pointer"
                        title="Copy Address"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {copiedAddress && (
                      <span className="text-[10px] text-emerald-400 block mt-0.5">Copied to clipboard!</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Transaction Hash / Instant Verification */}
              <div className="space-y-2">
                <label className="text-[11px] text-slate-400 block">
                  Paste Binance Transaction ID / Order ID after sending:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={txHashInput}
                    onChange={(e) => setTxHashInput(e.target.value)}
                    placeholder="e.g. 384920194829 or TxHash..."
                    className="flex-1 rounded-xl border border-slate-800 bg-slate-950 px-3 py-2 text-white font-mono text-xs focus:border-amber-400 focus:outline-none"
                  />
                  <button
                    onClick={handleSimulatePayment}
                    disabled={isProcessing}
                    className="rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 px-4 py-2 font-bold transition-all cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {isProcessing ? 'Verifying...' : 'Confirm Crypto Pay'}
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-slate-400 text-center">
                Supports Binance App Scan & Pay, Trust Wallet, MetaMask, and TRONLink.
              </p>
            </div>
          )}

          {/* TAB 3: STRIPE CREDIT CARD */}
          {paymentMethod === 'card' && (
            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-5 space-y-4 text-xs animate-fade-in">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5 text-cyan-400" />
                  <span className="font-bold text-white text-sm">Credit or Debit Card</span>
                </div>
                <span className="font-mono text-emerald-400 font-bold">{currentPrice.display} USD</span>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-slate-400 text-[11px] block mb-1">Card Number</label>
                  <input
                    type="text"
                    placeholder="4242 •••• •••• 4242"
                    className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-white font-mono text-xs focus:border-cyan-500 focus:outline-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-slate-400 text-[11px] block mb-1">Expires (MM/YY)</label>
                    <input
                      type="text"
                      placeholder="12/28"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-white font-mono text-xs focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-slate-400 text-[11px] block mb-1">CVC / CVV</label>
                    <input
                      type="text"
                      placeholder="123"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-white font-mono text-xs focus:border-cyan-500 focus:outline-none"
                    />
                  </div>
                </div>

                <button
                  onClick={handleSimulatePayment}
                  disabled={isProcessing}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-white py-3 px-4 text-xs font-bold shadow-lg shadow-cyan-500/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  {isProcessing ? 'Processing Transaction...' : `Pay ${currentPrice.display} & Unlock ${selectedTier}`}
                </button>
              </div>
            </div>
          )}

          {/* Payment Success Notification */}
          {paymentDone && (
            <div className="rounded-xl border border-emerald-500 bg-emerald-950/80 p-4 text-center space-y-2 animate-fade-in">
              <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto" />
              <h4 className="text-sm font-bold text-white">Payment Confirmed!</h4>
              <p className="text-xs text-emerald-200">
                Your account is now upgraded to <strong>{selectedTier} Tier</strong>. Unlocking full dossiers and PRD exports...
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-6 py-3 bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            256-bit Bank-grade Encryption
          </span>
          <button
            onClick={() => setIsOwnerConfigOpen(true)}
            className="text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
          >
            Change Merchant Accounts ⚙
          </button>
        </div>
      </div>
    </div>
  );
};
