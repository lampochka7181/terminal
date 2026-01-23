import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { usePrices } from '@/hooks/usePrices';
import { usePriceStore } from '@/stores/priceStore';
import { useAuthStore } from '@/stores/authStore';
import { useSessionKey, SESSION_DURATIONS } from '@/hooks/useSessionKey';
import { useDelegation } from '@/hooks/useDelegation';
import { useOrderbookStore, useYesOrderbook, useNoOrderbook } from '@/stores/orderbookStore';
import { api } from '@/lib/api';
import { getWebSocket } from '@/lib/websocket';
import { useUser } from '@/hooks/useUser';
import { useMarkets } from '@/hooks/useMarkets';
import { useSelectedMarket, useMarketStore } from '@/stores/marketStore';
import { useOrder } from '@/hooks/useOrder';

// ============================================
// ROLLIONS - Unified Trading Interface
// Modes: Preview → Base → Pro
// ============================================

// Info Tooltip Component
const InfoTooltip = ({ text }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative inline-flex ml-1.5">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="w-3.5 h-3.5 rounded-full bg-white/10 flex items-center justify-center text-[9px] text-white/40 hover:bg-white/20 hover:text-white/60 transition cursor-help"
      >
        i
      </button>
      {show && (
        <div 
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg text-[11px] text-white/80 whitespace-nowrap z-50"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.95)', border: '1px solid rgba(255,255,255,0.1)' }}
        >
          {text}
          <div 
            className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
            style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '5px solid rgba(0,0,0,0.95)' }}
          />
        </div>
      )}
    </div>
  );
};

export default function Rollions() {
  // Wallet connection state
  const wallet = useWallet();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const { isAuthenticated, isAuthenticating } = useAuthStore();
  const connected = wallet.connected;
  const walletAddress = wallet.publicKey?.toBase58();
  const shortAddress = walletAddress ? `${walletAddress.slice(0, 4)}...${walletAddress.slice(-3)}` : '';

  // Session key (one-click trade) state
  const session = useSessionKey();
  const oneClickEnabled = session.isActive;

  // Order placement hook - uses session key for instant signing when available
  const { placeOrder, isPlacing: isPlacingOrder, error: orderError, clearError: clearOrderError } = useOrder(session.sessionSigner);

  // Delegation state
  const delegation = useDelegation();

  // Real-time prices from WebSocket
  const { prices, loading: pricesLoading } = usePrices();

  // Market data - fetches active markets and syncs with selected asset/timeframe
  const { markets, refetch: refetchMarkets, onMarketExpired } = useMarkets();
  const { setAsset: setMarketAsset, setTimeframe: setMarketTimeframe } = useMarketStore();
  const activeMarket = useSelectedMarket();

  // Core trading state - price is derived from selected token
  const [localPrice, setLocalPrice] = useState(0); // Only used if no real price available
  const [selectedTimeframe, setSelectedTimeframe] = useState('5m');

  // Strike price comes from active market, fallback to price if no market
  const strike = useMemo(() => {
    if (activeMarket?.strike) return activeMarket.strike;
    // Fallback to current price if no active market yet
    return localPrice;
  }, [activeMarket?.strike, localPrice]);

  // Time left calculated from market expiry
  const [timeLeft, setTimeLeft] = useState(300);
  const [totalTime, setTotalTime] = useState(300);
  const [priceHistory, setPriceHistory] = useState([]);
  const [pulseTick, setPulseTick] = useState(0); // For chart animation
  const [amount, setAmount] = useState(100);
  const [showConfetti, setShowConfetti] = useState(false);
  const canvasRef = useRef(null);
  
  // Chart settings
  const [chartType, setChartType] = useState('line');
  const [chartTick, setChartTick] = useState('1s');
  const [showTools, setShowTools] = useState(false);
  const [selectedDrawingTool, setSelectedDrawingTool] = useState(null);
  
  // Order book state
  const [showOrderBook, setShowOrderBook] = useState(false);
  const [orderBookTab, setOrderBookTab] = useState('book');
  const [orderType, setOrderType] = useState('market'); // 'market' | 'limit'
  
  // One-click trade state - now driven by real session key hook
  // oneClickEnabled is derived from session.isActive (set above)
  const [showDelegateModal, setShowDelegateModal] = useState(false);
  // Delegation amount comes from delegation hook, with UI override for input
  const [delegateInputAmount, setDelegateInputAmount] = useState(1000);
  const delegatedAmount = (delegation.delegatedAmount || 0) / 1_000_000; // Convert from smallest units to USDC
  
  // Pro mode state
  // tradeType removed - volatility feature not included in new GUI
  const [chainWins, setChainWins] = useState(false);
  
  // Limit order state
  const [limitPrice, setLimitPrice] = useState(0.50);

  // Validation error state
  const [validationError, setValidationError] = useState(null);

  // Validation constants from ORDER_VALIDATION.md
  const VALIDATION = {
    MIN_BUY_USD: 5,
    MIN_SELL_USD: 0.02,
    PRICE_MIN: 0.01,
    PRICE_MAX: 0.99,
  };

  // Leverage state and calculation helpers (must match backend margin.service.ts)
  const [leverage, setLeverage] = useState(1);
  const [showLeverage, setShowLeverage] = useState(false);

  const leverageCalc = {
    initialMarginRequired: (totalPosition, lev) => totalPosition / lev,
    loanAmount: (totalPosition, lev) => totalPosition - (totalPosition / lev),
    /**
     * Calculate liquidation price for a leveraged position
     * Formula: liqPrice = loanAmount / (shares * (1 - maintenanceMarginPct))
     */
    liquidationPrice: (shares, _entryPrice, loanAmount, side) => {
      const maintenanceMarginPct = 0.03; // 3% - matches backend config
      if (shares <= 0 || loanAmount <= 0) return 0;
      const liqPriceYes = loanAmount / (shares * (1 - maintenanceMarginPct));
      const clampedLiqPrice = Math.max(0.01, Math.min(0.99, liqPriceYes));
      if (side === 'YES') {
        return clampedLiqPrice;
      }
      return 1 - clampedLiqPrice;
    },
  };

  // Calculate leverage stats for display
  const leverageStats = useMemo(() => {
    const isLeveraged = leverage > 1;
    const totalPosition = amount;
    const optionPrice = 0.50; // Will be calculated from odds when trade happens
    const shares = totalPosition / optionPrice;

    if (!isLeveraged || amount === 0) {
      return { isLeveraged: false, marginRequired: totalPosition, loanAmount: 0, liquidationPrice: 0 };
    }

    const marginRequired = leverageCalc.initialMarginRequired(totalPosition, leverage);
    const loanAmt = leverageCalc.loanAmount(totalPosition, leverage);
    const liquidationPrice = leverageCalc.liquidationPrice(shares, optionPrice, loanAmt, 'YES');

    return { isLeveraged, marginRequired, loanAmount: loanAmt, liquidationPrice };
  }, [leverage, amount]);

  // One-click trade menu state
  const [showOneClickMenu, setShowOneClickMenu] = useState(false);
  const [sessionDuration, setSessionDuration] = useState('4h');
  
  // Chatbox state
  const [chatExpanded, setChatExpanded] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    { user: 'degen_mike', msg: 'ABOVE ez money 🚀', time: '14:32' },
    { user: 'whale_0x7a', msg: 'just flipped $50 to $420 lmao', time: '14:31', isWin: true },
    { user: 'anon', msg: 'below gang wya', time: '14:31' },
    { user: 'btc_maxi', msg: 'this is the way', time: '14:30' },
    { user: 'ser_pump', msg: '🟢 +$186 ABOVE', time: '14:30', isWin: true },
    { user: 'ngmi_andy', msg: 'gg below rekt me', time: '14:29' },
  ]);
  
  // Token selection state - mapped to supported price feed assets
  const [selectedToken, setSelectedToken] = useState('BTC');
  const [showTokenDropdown, setShowTokenDropdown] = useState(false);
  const tokens = [
    { symbol: 'BTC', name: 'BTC/USD', icon: '₿', color: '#F7931A', asset: 'BTC' },
    { symbol: 'ETH', name: 'ETH/USD', icon: 'Ξ', color: '#627EEA', asset: 'ETH' },
    { symbol: 'SOL', name: 'SOL/USD', icon: '◎', color: '#9945FF', asset: 'SOL' },
  ];
  const currentToken = tokens.find(t => t.symbol === selectedToken) || tokens[0];

  // Derive price from real-time feed
  const price = useMemo(() => {
    const realPrice = prices[currentToken.asset];
    return realPrice || localPrice;
  }, [prices, currentToken.asset, localPrice]);

  // Sync selected asset/timeframe with market store
  useEffect(() => {
    setMarketAsset(currentToken.asset);
  }, [currentToken.asset, setMarketAsset]);

  useEffect(() => {
    setMarketTimeframe(selectedTimeframe);
  }, [selectedTimeframe, setMarketTimeframe]);

  // Calculate time left from active market expiry
  // Track if we're between markets (transitioning)
  const isMarketTransitioning = !activeMarket?.expiry || (activeMarket?.expiry && activeMarket.expiry <= Date.now());

  useEffect(() => {
    if (!activeMarket?.expiry) return;

    // Calculate total time based on timeframe (5m = 300s)
    const timeframeSeconds = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
    };
    const total = timeframeSeconds[selectedTimeframe] || 300;
    setTotalTime(total);

    // Update time left every second
    const updateTimeLeft = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((activeMarket.expiry - now) / 1000));
      setTimeLeft(remaining);

      // Trigger market refresh when expired
      if (remaining === 0) {
        onMarketExpired(selectedTimeframe, 1);
      }
    };

    updateTimeLeft();
    const interval = setInterval(updateTimeLeft, 1000);

    return () => clearInterval(interval);
  }, [activeMarket?.expiry, selectedTimeframe, onMarketExpired]);

  // UI state
  const [showPositions, setShowPositions] = useState(false);
  // Profile modal removed - not integrating per requirements
  const [showSettings, setShowSettings] = useState(false);
  const [showBuySell, setShowBuySell] = useState(true);
  const [playMusic, setPlayMusic] = useState(false);
  const [showRewardsPopup, setShowRewardsPopup] = useState(false);
  const [referralCode, setReferralCode] = useState('DEGEN-M7X2');
  const [referralsClaimed, setReferralsClaimed] = useState(3);
  const [referralEarnings, setReferralEarnings] = useState(847);
  
  // ============================================
  // MODE MANAGEMENT - The core flow
  // ============================================
  // 'preview' = locked mode before wallet connect
  // 'base' = unlocked, simple trading interface
  // 'pro' = unlocked, advanced trading with order book, tools
  const [appMode, setAppMode] = useState('preview'); // 'preview' | 'base' | 'pro'
  const [showOverlay, setShowOverlay] = useState(true); // Cinematic intro overlay
  const [showEnterCode, setShowEnterCode] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [codeError, setCodeError] = useState('');
  
  // Derived states for easier checks
  const isPreviewMode = appMode === 'preview';
  const isBaseMode = appMode === 'base';
  const isProMode = appMode === 'pro';
  const isUnlocked = !isPreviewMode;
  
  
  // Strike Y position for ABOVE/BELOW indicators (calculated in canvas)
  const [strikeYPosition, setStrikeYPosition] = useState(50); // percentage from top
  
  // Real user data from API
  const {
    balance: userBalance,
    positions: realPositions,
    orders: realOrders,
    transactions: realTransactions,
    positionsLoading,
    ordersLoading,
    transactionsLoading,
    refetchAll: refetchUserData,
  } = useUser();

  // Account balance from real user data
  const accountBalance = userBalance?.available || 0;

  // Round history derived from real transactions
  const roundHistory = useMemo(() => {
    if (!realTransactions || realTransactions.length === 0) return [];
    return realTransactions
      .filter(tx => tx.type === 'settlement')
      .slice(0, 5)
      .map(tx => tx.pnl > 0 ? 'W' : 'L');
  }, [realTransactions]);


  // Display positions from real data
  const displayPositions = useMemo(() => {
    if (!isAuthenticated || !realPositions) return [];
    return realPositions.map(p => ({
      side: p.yesShares > 0 ? 'above' : 'below',
      entry: p.avgEntryPrice || 0.50,
      size: p.yesShares > 0 ? p.yesShares * (p.avgEntryPrice || 0.50) : p.noShares * (p.avgEntryPrice || 0.50),
      shares: p.yesShares > 0 ? p.yesShares : p.noShares,
      asset: p.market?.asset || 'BTC',
      optionPrice: (p.avgEntryPrice || 0.50).toFixed(2),
      openedAt: new Date(p.createdAt).toLocaleTimeString('en-US', { hour12: false }),
      marketAddress: p.marketAddress,
      expiryAt: p.market?.expiryAt,
    }));
  }, [realPositions, isAuthenticated]);

  // Current position for the active market (for chart rendering and UI)
  const position = useMemo(() => {
    if (!activeMarket?.address) return null;
    return displayPositions.find(p => p.marketAddress === activeMarket.address) || null;
  }, [displayPositions, activeMarket?.address]);

  // Transaction history for positions panel
  const displayHistory = useMemo(() => {
    if (!isAuthenticated || !realTransactions) return [];
    return realTransactions.slice(0, 10).map(tx => ({
      id: tx.id,
      side: tx.outcome === 'YES' ? 'above' : 'below',
      entry: tx.price || 0.50,
      size: tx.dollarAmount || tx.size * tx.price,
      result: tx.type === 'settlement' ? (tx.pnl > 0 ? 'won' : 'lost') : 'filled',
      pnl: tx.pnl || 0,
      closedAt: new Date(tx.timestamp || tx.createdAt).toLocaleTimeString('en-US', { hour12: false }),
    }));
  }, [realTransactions, isAuthenticated]);

  const [sessionNumber, setSessionNumber] = useState(1);
  const [sessionStartIndex, setSessionStartIndex] = useState(0);
  
  // Real orderbook from store
  const orderbookSubscribed = useRef(false);
  const {
    yes: yesOrderbook,
    no: noOrderbook,
    trades: orderbookTrades,
    setOrderbook: setOrderbookData,
    updateLevel: updateOrderbookLevel,
    addTrade: addOrderbookTrade,
  } = useOrderbookStore();

  // Transform orderbook data for display (using YES/ABOVE side)
  const orderBook = useMemo(() => ({
    asks: yesOrderbook.asks.map(level => ({
      price: level.price,
      size: level.size,
      total: level.total || level.size,
    })),
    bids: yesOrderbook.bids.map(level => ({
      price: level.price,
      size: level.size,
      total: level.total || level.size,
    })),
    mid: yesOrderbook.midPrice,
    spread: yesOrderbook.spread,
  }), [yesOrderbook]);

  // Transform recent trades for display
  const recentTrades = useMemo(() =>
    orderbookTrades.slice(0, 5).map(trade => ({
      price: trade.price.toFixed(2),
      size: trade.size,
      side: trade.side,
      time: new Date(trade.timestamp).toLocaleTimeString('en-US', { hour12: false }),
    })),
    [orderbookTrades]
  );

  // Volume derived from orderbook depth
  const aboveVolume = useMemo(() => {
    const bidTotal = yesOrderbook.bids.reduce((sum, level) => sum + (level.size * level.price), 0);
    return Math.round(bidTotal) || 0;
  }, [yesOrderbook.bids]);

  const belowVolume = useMemo(() => {
    const askTotal = yesOrderbook.asks.reduce((sum, level) => sum + (level.size * level.price), 0);
    return Math.round(askTotal) || 0;
  }, [yesOrderbook.asks]);

  // Get market address from active market
  const marketAddress = activeMarket?.address || null;

  // Fetch orderbook data and subscribe to WebSocket updates
  const fetchOrderbook = useCallback(async () => {
    if (!marketAddress) return;

    try {
      const data = await api.getOrderbook(marketAddress);
      const yesBids = (data.yes?.bids || data.bids || []);
      const yesAsks = (data.yes?.asks || data.asks || []);
      setOrderbookData('YES', yesBids, yesAsks, data.sequenceId);
    } catch (err) {
      console.error('[Orderbook] Fetch error:', err);
    }
  }, [marketAddress, setOrderbookData]);

  // WebSocket subscription for orderbook updates
  useEffect(() => {
    if (!marketAddress) return;

    const ws = getWebSocket();

    const unsubscribe = ws.onMessage((message) => {
      if (message.channel !== 'orderbook') return;

      const messageMarket = message.market || message.data?.marketId;
      if (messageMarket !== marketAddress) return;

      const data = message.data;
      if (!data) return;

      const outcome = (data.outcome) || 'YES';
      const bids = (data.bids || []);
      const asks = (data.asks || []);

      // Full snapshot or delta update
      if (message.snapshot || (bids.length > 5 || asks.length > 5)) {
        setOrderbookData(outcome, bids, asks, data.sequenceId);
      } else {
        // Apply tick-by-tick updates
        bids.forEach(([price, size]) => updateOrderbookLevel(outcome, 'bid', price, size));
        asks.forEach(([price, size]) => updateOrderbookLevel(outcome, 'ask', price, size));
      }
    });

    const handleConnect = () => {
      if (marketAddress && !orderbookSubscribed.current) {
        ws.subscribeOrderbook(marketAddress);
        orderbookSubscribed.current = true;
      }
    };

    const unsubscribeConnect = ws.onConnect(handleConnect);

    if (ws.isConnected && !orderbookSubscribed.current) {
      ws.subscribeOrderbook(marketAddress);
      orderbookSubscribed.current = true;
    }

    // Fetch initial data
    fetchOrderbook();

    return () => {
      unsubscribe();
      unsubscribeConnect();
      if (orderbookSubscribed.current && marketAddress) {
        ws.unsubscribeOrderbook(marketAddress);
        orderbookSubscribed.current = false;
      }
    };
  }, [marketAddress, fetchOrderbook, setOrderbookData, updateOrderbookLevel]);
  
  // Timeframe configs - restricted to 5m only per requirements
  const timeframeConfigs = {
    '5m': { seconds: 300, label: '5 minutes' },
  };
  
  // Tick configs
  const tickConfigs = ['1s', '5s', '15s', '30s', '1m'];
  
  // Drawing tools
  const drawingTools = [
    { id: 'hline', icon: '─', label: 'Horizontal Line' },
    { id: 'trendline', icon: '╲', label: 'Trend Line' },
    { id: 'up', icon: '∧', label: 'Arrow Up' },
    { id: 'down', icon: '∨', label: 'Arrow Down' },
    { id: 'rect', icon: '□', label: 'Rectangle' },
    { id: 'text', icon: 'T', label: 'Text' },
    { id: 'search', icon: '⌕', label: 'Search' },
  ];
  
  // Market prices from orderbook (best ask for buying)
  // Above = YES contracts, Below = NO contracts
  const abovePrice = useMemo(() => {
    // Best ask price to buy YES, or use mid price, or fallback to active market price
    const bestAsk = yesOrderbook.asks[0]?.price;
    const mid = yesOrderbook.midPrice;
    const marketPrice = activeMarket?.yesPrice;
    return bestAsk || mid || marketPrice || 0.50;
  }, [yesOrderbook.asks, yesOrderbook.midPrice, activeMarket?.yesPrice]);

  const belowPrice = useMemo(() => {
    // Use actual NO orderbook price, fallback to 1 - YES price
    const bestAsk = noOrderbook.asks[0]?.price;
    const mid = noOrderbook.midPrice;
    const marketPrice = activeMarket?.noPrice;
    return bestAsk || mid || marketPrice || Math.max(0.01, Math.min(0.99, 1 - abovePrice));
  }, [noOrderbook.asks, noOrderbook.midPrice, activeMarket?.noPrice, abovePrice]);

  // Above percent is the probability (price) expressed as percentage
  const abovePercent = Math.round(abovePrice * 100);

  // Computed values
  const isAboveStrike = price >= strike;
  const isWinning = position ? (position.side === 'above' ? isAboveStrike : !isAboveStrike) : null;

  // Calculate real PnL based on current market prices
  // PnL = (current market value) - (cost basis)
  // Current value = shares * current price of that outcome
  // Cost = shares * entry price (which equals position.size)
  const currentOptionPrice = position ? (position.side === 'above' ? abovePrice : belowPrice) : 0;
  const pnl = position ? (position.shares * currentOptionPrice) - position.size : 0;
  const pnlPercent = position && position.size > 0 ? (pnl / position.size * 100) : 0;
  const strikeDistance = ((price - strike) / strike * 100);
  const finalCountdown = timeLeft <= 10;
  const lateEntry = timeLeft <= 60 && timeLeft > 10;
  
  const formatTime = (s) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
  const formatPrice = (p) => p?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '0.00';

  // ============================================
  // MODE TRANSITION HANDLERS
  // ============================================
  const handleUnlock = (code) => {
    // In production, validate the code against a backend
    // For now, accept any non-empty code or specific test codes
    const validCodes = ['COIN', 'GENESIS', 'DEGEN', 'TEST'];
    const isValid = code.length >= 4 || validCodes.includes(code.toUpperCase());
    
    if (isValid) {
      setAppMode('base');
      setShowEnterCode(false);
      setCodeError('');
      setInviteCode('');
    } else {
      setCodeError('Invalid code. Please try again.');
    }
  };
  
  const toggleProMode = () => {
    if (isPreviewMode) return; // Can't toggle pro in preview
    setAppMode(isProMode ? 'base' : 'pro');
  };

  const handleTimeframeChange = (tf) => {
    setSelectedTimeframe(tf);
    // Time and strike will be updated automatically from the active market
  };

  // Sync tools/orderbook visibility with mode
  useEffect(() => {
    if (isProMode) {
      setShowTools(true);
      setChartType('candle');
      setShowOrderBook(true); // Always show order book in Pro
      setShowPositions(true); // Show positions tab by default in Pro
    } else {
      setShowTools(false);
      setChartType('line');
      setShowOrderBook(false);
      setShowPositions(false);
    }
  }, [isProMode]);

  // Reset price history when token changes - will build up from real-time updates
  useEffect(() => {
    setPriceHistory([]);
    setSessionStartIndex(0);
  }, [currentToken.asset]);

  // Handle session reset when market expires (timer hits zero)
  const prevTimeLeft = useRef(timeLeft);
  useEffect(() => {
    // Check if timer just hit zero (transition from >0 to 0)
    if (prevTimeLeft.current > 0 && timeLeft === 0) {
      // Backend handles position settlement automatically
      // Just update local session tracking
      setSessionNumber(n => n + 1);
      setSessionStartIndex(priceHistory.length);
    }
    prevTimeLeft.current = timeLeft;
  }, [timeLeft, priceHistory.length]);

  // Price updates - build history from real-time price feed
  const lastRealPrice = useRef(null);
  useEffect(() => {
    const realPrice = prices[currentToken.asset];

    // If we have real price data, update price history with it
    if (realPrice && realPrice !== lastRealPrice.current) {
      lastRealPrice.current = realPrice;
      setPriceHistory(hist => {
        const last = hist[hist.length - 1];
        return [...hist.slice(-199), {
          price: realPrice,
          open: last?.close || realPrice,
          high: Math.max(last?.close || realPrice, realPrice),
          low: Math.min(last?.close || realPrice, realPrice),
          close: realPrice
        }];
      });
    }
  }, [prices, currentToken.asset]);

  // Animation tick for chart pulse effect (60fps)
  useEffect(() => {
    const interval = setInterval(() => {
      setPulseTick(t => t + 1);
    }, 50); // 20fps for smooth animation
    return () => clearInterval(interval);
  }, []);

  // Chart rendering
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || priceHistory.length < 2) return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * 2;
    canvas.height = rect.height * 2;
    ctx.scale(2, 2);
    const W = rect.width, H = rect.height;
    const pad = { t: 20, r: Math.round(W * 0.25), b: 20, l: 8 };
    const finishZoneWidth = Math.round(W * 0.10);
    
    const drawRoundRect = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    };
    
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, W, H);
    
    const chartCenterX = W * 0.5;
    ctx.font = 'bold 120px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(selectedTimeframe.toUpperCase(), chartCenterX, H * 0.5);
    ctx.textBaseline = 'alphabetic';
    
    const data = priceHistory.slice(-80);
    const prices = data.map(d => d.price);

    // Calculate range centered on strike price
    // Find max distance from strike to any price point
    // Note: position.entry is the option price (e.g. $0.50), not underlying price, so exclude it
    const allPricePoints = [...prices, ...data.map(d => d.low), ...data.map(d => d.high)].filter(p => p != null && isFinite(p));

    // Use current price as fallback if strike is missing or invalid
    const effectiveStrike = (strike && isFinite(strike) && strike > 0) ? strike : (prices[prices.length - 1] || price);

    // Guard against empty price points
    const distances = allPricePoints.map(p => Math.abs(p - effectiveStrike));
    const maxDistanceFromStrike = distances.length > 0
      ? Math.max(...distances, 60)
      : 200; // Default range if no data
    // Add padding and make symmetric around strike
    const padding = maxDistanceFromStrike * 0.15 + 30;
    const halfRange = maxDistanceFromStrike + padding;
    const minP = effectiveStrike - halfRange;
    const maxP = effectiveStrike + halfRange;
    const range = maxP - minP;
    const toY = (p) => pad.t + (1 - (p - minP) / range) * (H - pad.t - pad.b);
    const toX = (i) => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
    
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    const priceSteps = 5;
    for (let i = 0; i <= priceSteps; i++) {
      const p = minP + (range * i / priceSteps);
      const y = toY(p);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    
    const finishX = W - pad.r;
    const finishZoneStart = W - finishZoneWidth;
    const strikeY = toY(effectiveStrike);
    const badgeCenterX = finishZoneStart + finishZoneWidth / 2;
    
    // Store strike Y position as percentage for React-based indicators
    const strikeYPercent = (strikeY / H) * 100;
    if (Math.abs(strikeYPercent - strikeYPosition) > 1) {
      setStrikeYPosition(strikeYPercent);
    }
    
    // Above/Below zones - only in Base mode (or Preview which shows like Base)
    if (!isProMode) {
      const aboveGrad = ctx.createLinearGradient(finishZoneStart, 0, W, 0);
      aboveGrad.addColorStop(0, 'rgba(28, 185, 85, 0)');
      aboveGrad.addColorStop(0.4, 'rgba(28, 185, 85, 0.04)');
      aboveGrad.addColorStop(1, 'rgba(28, 185, 85, 0.08)');
      ctx.fillStyle = aboveGrad;
      ctx.fillRect(finishZoneStart, 0, finishZoneWidth, strikeY);
      
      // Only draw zone labels when not in preview mode (preview has HTML tags)
      if (!isPreviewMode) {
        ctx.font = 'bold 9px -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(28, 185, 85, 0.25)';
        ctx.textAlign = 'center';
        const aboveZoneCenterY = strikeY / 2;
        ctx.fillText('ABOVE', badgeCenterX, aboveZoneCenterY);
      }
      
      const belowGrad = ctx.createLinearGradient(finishZoneStart, 0, W, 0);
      belowGrad.addColorStop(0, 'rgba(233, 21, 41, 0)');
      belowGrad.addColorStop(0.4, 'rgba(233, 21, 41, 0.04)');
      belowGrad.addColorStop(1, 'rgba(233, 21, 41, 0.08)');
      ctx.fillStyle = belowGrad;
      ctx.fillRect(finishZoneStart, strikeY, finishZoneWidth, H - strikeY);
      
      if (!isPreviewMode) {
        ctx.fillStyle = 'rgba(233, 21, 41, 0.25)';
        const belowZoneCenterY = strikeY + (H - strikeY) / 2;
        ctx.fillText('BELOW', badgeCenterX, belowZoneCenterY);
      }
    }
    
    // Strike line glow
    const strikeGlow = ctx.createLinearGradient(0, strikeY - 15, 0, strikeY + 15);
    strikeGlow.addColorStop(0, 'rgba(255, 180, 0, 0)');
    strikeGlow.addColorStop(0.5, `rgba(255, 180, 0, ${finalCountdown ? 0.12 : 0.06})`);
    strikeGlow.addColorStop(1, 'rgba(255, 180, 0, 0)');
    ctx.fillStyle = strikeGlow;
    ctx.fillRect(0, strikeY - 15, W, 30);
    
    const strikeBadgeColor = finalCountdown ? '#E91529' : '#FFB800';
    ctx.strokeStyle = strikeBadgeColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(0, strikeY);
    ctx.lineTo(finishZoneStart - 5, strikeY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const strikePriceText = `$${formatPrice(effectiveStrike)}`;
    ctx.font = 'bold 10px -apple-system, sans-serif';
    const strikeBadgeWidth = ctx.measureText(strikePriceText).width + 12;
    
    ctx.fillStyle = strikeBadgeColor;
    drawRoundRect(badgeCenterX - strikeBadgeWidth/2, strikeY - 10, strikeBadgeWidth, 20, 4);
    ctx.fill();
    
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.fillText(strikePriceText, badgeCenterX, strikeY + 3);

    // Position indicator + PNL zone
    if (position) {
      const currentY = toY(price);

      // Highlight the winning/losing zone from strike to current price
      const zoneTop = Math.min(strikeY, currentY);
      const zoneHeight = Math.abs(strikeY - currentY);

      if (zoneHeight > 2) {
        const zoneGrad = ctx.createLinearGradient(0, zoneTop, 0, zoneTop + zoneHeight);
        zoneGrad.addColorStop(0, isWinning ? 'rgba(28, 185, 85, 0.15)' : 'rgba(233, 21, 41, 0.15)');
        zoneGrad.addColorStop(1, isWinning ? 'rgba(28, 185, 85, 0.02)' : 'rgba(233, 21, 41, 0.02)');
        ctx.fillStyle = zoneGrad;
        ctx.fillRect(0, zoneTop, finishX, zoneHeight);
      }

      // Position info badge in top-left corner
      const entryPrice = position.entry || 0;
      const positionSize = position.size || 0;
      const positionText = `${(position.side || 'above').toUpperCase()} @ $${entryPrice.toFixed(2)}`;
      const sizeText = `$${positionSize.toFixed(0)}`;

      ctx.font = 'bold 11px -apple-system, sans-serif';
      const posTextWidth = ctx.measureText(positionText).width;
      const sizeTextWidth = ctx.measureText(sizeText).width;
      const badgeWidth = Math.max(posTextWidth, sizeTextWidth) + 16;
      const badgeX = 8;
      const badgeY = pad.t + 8;

      // Draw position badge background
      ctx.fillStyle = position.side === 'above' ? 'rgba(28, 185, 85, 0.2)' : 'rgba(233, 21, 41, 0.2)';
      drawRoundRect(badgeX, badgeY, badgeWidth, 36, 6);
      ctx.fill();

      // Draw position text
      ctx.fillStyle = position.side === 'above' ? '#1CB955' : '#E91529';
      ctx.textAlign = 'left';
      ctx.fillText(positionText, badgeX + 8, badgeY + 14);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillText(`Size: ${sizeText}`, badgeX + 8, badgeY + 28);

      // PnL Badge - positioned at current price level
      const pnlText = `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}`;
      ctx.font = 'bold 13px -apple-system, sans-serif';
      const pnlWidth = ctx.measureText(pnlText).width + 16;
      const pnlBadgeX = W * 0.6;
      const pnlBadgeY = currentY + (position.side === 'above' ? -30 : 10);

      // Draw PnL badge background
      ctx.fillStyle = isWinning ? '#1CB955' : '#E91529';
      drawRoundRect(pnlBadgeX - pnlWidth/2, pnlBadgeY, pnlWidth, 24, 6);
      ctx.fill();

      // Draw PnL badge text
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(pnlText, pnlBadgeX, pnlBadgeY + 16);
      ctx.font = '10px -apple-system, sans-serif';
    }

    // Chart color based on price vs strike (not price direction)
    const currentPrice = data[data.length - 1]?.price || price;
    const aboveStrike = currentPrice >= effectiveStrike;
    const lineColor = aboveStrike ? '#1CB955' : '#E91529';

    if (chartType === 'candle') {
      const candleWidth = Math.max(2, (W - pad.l - pad.r) / data.length * 0.7);
      data.forEach((d, i) => {
        const x = toX(i);
        const isGreen = d.close >= d.open;
        const color = isGreen ? '#1CB955' : '#E91529';
        
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, toY(d.high));
        ctx.lineTo(x, toY(d.low));
        ctx.stroke();
        
        const bodyTop = toY(Math.max(d.open, d.close));
        const bodyBottom = toY(Math.min(d.open, d.close));
        const bodyHeight = Math.max(1, bodyBottom - bodyTop);
        ctx.fillStyle = color;
        ctx.fillRect(x - candleWidth/2, bodyTop, candleWidth, bodyHeight);
      });
    } else {
      // Helper to draw smooth bezier curve through points
      const drawSmoothLine = (points, close = false) => {
        if (points.length < 2) return;
        ctx.moveTo(points[0].x, points[0].y);

        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;

          // Catmull-Rom to Bezier conversion for smooth curves
          const tension = 0.3;
          const cp1x = p1.x + (p2.x - p0.x) * tension;
          const cp1y = p1.y + (p2.y - p0.y) * tension;
          const cp2x = p2.x - (p3.x - p1.x) * tension;
          const cp2y = p2.y - (p3.y - p1.y) * tension;

          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
      };

      // Convert data to points
      const points = data.map((d, i) => ({ x: toX(i), y: toY(d.price) }));

      // Draw filled area under curve
      const gradient = ctx.createLinearGradient(0, 0, 0, H);
      gradient.addColorStop(0, aboveStrike ? 'rgba(28, 185, 85, 0.1)' : 'rgba(233, 21, 41, 0.1)');
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.moveTo(toX(0), H - pad.b);
      ctx.lineTo(points[0].x, points[0].y);
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const tension = 0.3;
        const cp1x = p1.x + (p2.x - p0.x) * tension;
        const cp1y = p1.y + (p2.y - p0.y) * tension;
        const cp2x = p2.x - (p3.x - p1.x) * tension;
        const cp2y = p2.y - (p3.y - p1.y) * tension;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.lineTo(toX(data.length - 1), H - pad.b);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Draw smooth line
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const tension = 0.3;
        const cp1x = p1.x + (p2.x - p0.x) * tension;
        const cp1y = p1.y + (p2.y - p0.y) * tension;
        const cp2x = p2.x - (p3.x - p1.x) * tension;
        const cp2y = p2.y - (p3.y - p1.y) * tension;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Current price dot with animated pulsing glow
    const lastX = toX(data.length - 1);
    const lastY = toY(data[data.length - 1].price);

    // Pulse animation based on time (cycles every 1.5 seconds)
    const pulseTime = Date.now() / 1500;
    const pulse = 0.5 + 0.5 * Math.sin(pulseTime * Math.PI * 2);
    const outerRadius = 8 + pulse * 6; // Pulses between 8 and 14
    const outerOpacity = 0.08 + pulse * 0.12; // Pulses between 0.08 and 0.20

    // Outer pulsing glow
    ctx.beginPath();
    ctx.arc(lastX, lastY, outerRadius, 0, Math.PI * 2);
    ctx.fillStyle = aboveStrike
      ? `rgba(28, 185, 85, ${outerOpacity})`
      : `rgba(233, 21, 41, ${outerOpacity})`;
    ctx.fill();

    // Middle ring
    ctx.beginPath();
    ctx.arc(lastX, lastY, 6, 0, Math.PI * 2);
    ctx.fillStyle = aboveStrike ? 'rgba(28, 185, 85, 0.3)' : 'rgba(233, 21, 41, 0.3)';
    ctx.fill();

    // Inner solid dot
    ctx.beginPath();
    ctx.arc(lastX, lastY, 4, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
    
    const priceBadgeText = `$${formatPrice(price)}`;
    ctx.font = 'bold 10px -apple-system, sans-serif';
    const priceBadgeWidth = ctx.measureText(priceBadgeText).width + 12;
    const priceBadgeY = lastY;
    
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(lastX + 6, lastY);
    ctx.lineTo(finishZoneStart - 5, lastY);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.fillStyle = lineColor;
    drawRoundRect(badgeCenterX - priceBadgeWidth/2, priceBadgeY - 10, priceBadgeWidth, 20, 4);
    ctx.fill();
    
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.fillText(priceBadgeText, badgeCenterX, priceBadgeY + 3);
    
  }, [priceHistory, strike, position, isWinning, pnl, finalCountdown, price, chartType, timeLeft, totalTime, sessionStartIndex, selectedTimeframe, isProMode, showBuySell, pulseTick]);

  const handleTrade = async (side) => {
    if (isPreviewMode) {
      // In preview mode, clicking trade opens the code modal
      setShowEnterCode(true);
      return;
    }
    if (!connected) { setWalletModalVisible(true); return; }
    if (finalCountdown || isPlacingOrder) return;
    if (!activeMarket?.address) {
      setValidationError('No active market available');
      return;
    }

    // Clear previous validation error
    setValidationError(null);
    clearOrderError();

    // Validation: minimum buy amount
    if (amount < VALIDATION.MIN_BUY_USD) {
      setValidationError(`Minimum buy is $${VALIDATION.MIN_BUY_USD}`);
      return;
    }

    // Get option price from market prices
    const optionPrice = side === 'above' ? abovePrice : belowPrice;

    // Validation: price must be in valid range
    if (optionPrice < VALIDATION.PRICE_MIN || optionPrice > VALIDATION.PRICE_MAX) {
      setValidationError(`Price must be between $${VALIDATION.PRICE_MIN} and $${VALIDATION.PRICE_MAX}`);
      return;
    }

    // Place real order via API
    const result = await placeOrder({
      marketAddress: activeMarket.address,
      side: 'bid', // Always buying
      outcome: side === 'above' ? 'yes' : 'no',
      orderType: 'market',
      price: optionPrice,
      size: amount / optionPrice, // Convert dollar amount to shares
      dollarAmount: amount,
      maxPrice: Math.min(0.99, optionPrice * 1.05), // 5% slippage protection
      leverage: leverage > 1 ? leverage : undefined,
      marginAmount: leverage > 1 ? amount : undefined,
    });

    if (result && !result.error) {
      setShowPositions(true);
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 2000);
    } else if (result?.error) {
      setValidationError(result.error);
    }
  };

  const handleClosePosition = async (positionToClose) => {
    // Close position by placing a sell order
    if (!positionToClose?.marketAddress || isPlacingOrder) return;

    clearOrderError();

    const result = await placeOrder({
      marketAddress: positionToClose.marketAddress,
      side: 'ask', // Selling
      outcome: positionToClose.side === 'above' ? 'yes' : 'no',
      orderType: 'market',
      price: 0.01, // Min price for market sell
      size: positionToClose.shares,
    });

    if (result?.error) {
      setValidationError(result.error);
    }
  };

  // Multipliers based on price → redeem at $1
  // e.g., buy at $0.50 → redeem at $1 = 2x multiplier
  const aboveOdds = (1 / abovePrice).toFixed(2);
  const belowOdds = (1 / belowPrice).toFixed(2);
  const abovePayout = (amount * parseFloat(aboveOdds)).toFixed(0);
  const belowPayout = (amount * parseFloat(belowOdds)).toFixed(0);

  // Greeks calculations for Pro mode
  // Delta: probability of finishing ITM (from odds)
  const deltaAbove = (1 / parseFloat(aboveOdds)).toFixed(2);
  const deltaBelow = (1 / parseFloat(belowOdds)).toFixed(2);
  
  // Theta: time decay per minute (simplified for binary options)
  // Shows expected value change rate based on position
  const timeRemainingMinutes = timeLeft / 60;
  const thetaValue = position 
    ? (pnl / Math.max(timeRemainingMinutes, 0.1)).toFixed(2)
    : ((-amount * 0.02) / Math.max(timeRemainingMinutes, 1)).toFixed(2); // ~2% decay per min estimate
  
  // IV: derived from odds balance (more balanced = higher IV = more uncertainty)
  const oddsRatio = Math.max(parseFloat(aboveOdds), parseFloat(belowOdds)) / Math.min(parseFloat(aboveOdds), parseFloat(belowOdds));
  const impliedVolatility = Math.round(Math.max(15, Math.min(85, 100 - (oddsRatio - 1) * 50)));
  
  // Win rate calculation
  const wins = roundHistory.filter(r => r === 'W').length;
  const winRate = roundHistory.length > 0 ? Math.round((wins / roundHistory.length) * 100) : 0;
  
  // Current exposure
  const currentExposure = position ? position.size : 0;

  const maxBookSize = Math.max(...orderBook.asks.map(a => a.total), ...orderBook.bids.map(b => b.total));

  // ============================================
  // RENDER
  // ============================================
  return (
    <div className="h-screen bg-black flex flex-col overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      
      {/* Confetti */}
      {showConfetti && (
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          {[...Array(50)].map((_, i) => (
            <div
              key={i}
              className="absolute"
              style={{
                left: `${Math.random() * 100}%`,
                top: '-20px',
                width: `${6 + Math.random() * 6}px`,
                height: `${6 + Math.random() * 6}px`,
                backgroundColor: ['#1CB955', '#FFD700', '#E91529', '#00BFFF'][Math.floor(Math.random() * 4)],
                borderRadius: Math.random() > 0.5 ? '50%' : '2px',
                animation: `confetti ${1 + Math.random() * 0.5}s ease-out forwards`,
                animationDelay: `${Math.random() * 0.3}s`
              }}
            />
          ))}
        </div>
      )}

      {/* Order Error Toast */}
      {(validationError || orderError) && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] max-w-md w-full mx-4 animate-in slide-in-from-top duration-300">
          <div className="bg-red-900/90 backdrop-blur-sm border border-red-500/50 rounded-xl p-4 shadow-2xl shadow-red-500/20">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#ef4444" strokeWidth="2">
                  <circle cx="8" cy="8" r="7" />
                  <path d="M8 4.5v4" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.5" fill="#ef4444" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-red-300 font-semibold text-sm mb-1">Order Failed</div>
                <div className="text-red-200/80 text-xs leading-relaxed break-words">
                  {validationError || orderError}
                </div>
                {(validationError || orderError)?.includes('delegation') && (
                  <button
                    onClick={() => {
                      setShowDelegateModal(true);
                      setValidationError(null);
                      clearOrderError();
                    }}
                    className="mt-2 px-3 py-1.5 bg-red-500/30 hover:bg-red-500/50 rounded-lg text-red-200 text-xs font-semibold transition"
                  >
                    Increase Delegation
                  </button>
                )}
              </div>
              <button
                onClick={() => {
                  setValidationError(null);
                  clearOrderError();
                }}
                className="flex-shrink-0 p-1 hover:bg-red-500/20 rounded transition"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="#fca5a5" strokeWidth="2">
                  <path d="M2 2l10 10M12 2L2 12" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================ */}
      {/* CINEMATIC INTRO OVERLAY */}
      {/* ============================================ */}
      {showOverlay && isPreviewMode && (
        <div 
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ 
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)'
          }}
        >
          {/* Subtle animated gradient background */}
          <div 
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(ellipse at 30% 30%, rgba(28, 185, 85, 0.08) 0%, transparent 50%), radial-gradient(ellipse at 70% 70%, rgba(233, 21, 41, 0.06) 0%, transparent 50%)',
              animation: 'pulse-slow 4s ease-in-out infinite'
            }}
          />
          
          {/* Content */}
          <div className="relative text-center px-8 max-w-xl">
            {/* Logo - fades in first */}
            <div 
              className="flex items-center justify-center gap-2 mb-16"
              style={{ animation: 'fadeIn 0.8s ease-out forwards', opacity: 0, animationDelay: '0.2s', animationFillMode: 'forwards' }}
            >
              <span className="font-black text-2xl" style={{ color: '#1CB955' }}>//</span>
              <span className="text-white/60 font-semibold text-lg tracking-wide">Rollions</span>
            </div>
            
            {/* Main headline - fades in second */}
            <h1 
              className="text-5xl md:text-7xl font-bold text-white mb-6 tracking-tight"
              style={{ animation: 'fadeInUp 0.8s ease-out forwards', opacity: 0, animationDelay: '0.5s', animationFillMode: 'forwards' }}
            >
              Up or down?
            </h1>
            
            {/* Subtext - fades in third */}
            <p 
              className="text-base md:text-lg text-white/50 mb-16 max-w-md uppercase tracking-wide"
              style={{ animation: 'fadeInUp 0.8s ease-out forwards', opacity: 0, animationDelay: '0.8s', animationFillMode: 'forwards' }}
            >
              Pick a time. 1 to 60 minutes.<br />
              Will price go up or down?
            </p>
            
            {/* CTA - fades in last */}
            <div style={{ animation: 'fadeInUp 0.8s ease-out forwards', opacity: 0, animationDelay: '1.2s', animationFillMode: 'forwards' }}>
              <button 
                onClick={() => setShowOverlay(false)}
                className="group inline-flex items-center gap-3 px-10 py-4 rounded-full font-semibold text-lg text-black transition-all duration-300 hover:scale-105 hover:shadow-lg hover:shadow-green-500/20"
                style={{ backgroundColor: '#1CB955' }}
              >
                Trade Now
                <svg 
                  width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  className="transition-transform duration-300 group-hover:translate-x-1"
                >
                  <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <p className="mt-4 text-xs text-white/40 uppercase tracking-widest">
                Rolling Options
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ============================================ */}
      {/* NAVIGATION BAR */}
      {/* ============================================ */}
      <nav className="h-12 border-b border-white/5 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center">
          {/* Logo */}
          <div className="flex items-center gap-2 pr-5 mr-5 border-r border-white/10">
            <span className="font-black text-xl" style={{ color: '#1CB955' }}>//</span>
            <span className="text-white font-semibold">Rollions</span>
          </div>
          
          {/* Preview Mode: Nav links aligned left after logo */}
          {isPreviewMode && (
            <div className="flex items-center gap-5">
              <button 
                onClick={() => setShowHowItWorks(true)}
                className="text-sm text-white/50 hover:text-white transition"
              >
                How it Works
              </button>
              <button 
                className="text-sm text-white/50 hover:text-white transition"
              >
                Join Waitlist
              </button>
              <button 
                onClick={() => setShowEnterCode(true)}
                className="text-sm text-white/50 hover:text-white transition"
              >
                Enter Code
              </button>
            </div>
          )}
          
          {/* Mode toggle when unlocked */}
          {isUnlocked && (
            <button 
              onClick={() => setAppMode(isProMode ? 'base' : 'pro')}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 hover:border-white/20 transition cursor-pointer" 
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
            >
              <span className="text-white/60 text-xs font-medium">{isProMode ? 'Lite' : 'Pro'}</span>
              <div className="relative w-7 h-4 rounded-full transition-colors" style={{ backgroundColor: isProMode ? '#1CB955' : 'rgba(255,255,255,0.2)' }}>
                <div 
                  className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all duration-200"
                  style={{ left: isProMode ? '14px' : '2px' }}
                />
              </div>
            </button>
          )}
        </div>
        
        <div className="flex items-center gap-3">
          {/* Base/Pro mode: Balance, Session, Rewards */}
          {isUnlocked && connected && (
            <>
              {/* One-click trade button / Delegated balance */}
              <div className="relative">
                {oneClickEnabled ? (
                  <button 
                    onClick={() => setShowOneClickMenu(!showOneClickMenu)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition" 
                    style={{ borderColor: 'rgba(28, 185, 85, 0.3)', backgroundColor: 'rgba(28, 185, 85, 0.1)' }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#1CB955" strokeWidth="2">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="text-sm font-semibold" style={{ color: '#1CB955' }}>${delegatedAmount.toLocaleString()}</span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="text-white/40">
                      <path d="M3 5L6 7L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                    </svg>
                  </button>
                ) : (
                  <button 
                    onClick={() => setShowOneClickMenu(!showOneClickMenu)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 hover:border-white/30 transition bg-white/5 hover:bg-white/10"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/60">
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="text-sm text-white/70">One-click trade</span>
                  </button>
                )}
                
                {/* One-click trade settings popup */}
                {showOneClickMenu && (
                  <div 
                    className="absolute top-full right-0 mt-2 w-80 rounded-xl border border-white/10 z-50 overflow-hidden"
                    style={{ backgroundColor: 'rgba(15, 15, 15, 0.98)', backdropFilter: 'blur(12px)' }}
                  >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                      <div className="flex items-center gap-2">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1CB955" strokeWidth="2">
                          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span className="text-sm font-semibold text-white">Trading Session</span>
                      </div>
                      <button onClick={() => setShowOneClickMenu(false)} className="text-white/30 hover:text-white/60 transition">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </div>
                    
                    <div className="p-4">
                      {/* Description */}
                      <p className="text-xs text-white/40 mb-4">
                        Start a trading session to sign orders instantly without wallet popups. You'll sign once to authorize, then trade freely.
                      </p>

                      {/* Session Status */}
                      {oneClickEnabled && (
                        <div className="mb-4 p-3 rounded-lg bg-long/10 border border-long/20">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-white/50">Session Active</span>
                            <span className="text-sm font-mono text-long">
                              {Math.floor(session.getTimeRemaining() / 3600)}h {Math.floor((session.getTimeRemaining() % 3600) / 60)}m left
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Delegated Balance */}
                      <div className="mb-4">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-white/50 uppercase tracking-wider">Delegate Amount</span>
                          <span className="text-lg font-bold" style={{ color: '#1CB955' }}>${delegatedAmount.toLocaleString()}</span>
                        </div>

                        <div className="flex items-center gap-2 mb-2">
                          <input
                            type="number"
                            value={delegateInputAmount}
                            onChange={(e) => setDelegateInputAmount(Math.max(0, parseInt(e.target.value) || 0))}
                            className="flex-1 h-10 bg-white/5 border border-white/10 rounded-lg px-3 text-white font-mono focus:outline-none focus:border-white/30 transition"
                            disabled={delegation.isApproving}
                          />
                        </div>

                        <div className="flex gap-1.5">
                          {[1000, 5000, 10000, 25000].map(val => (
                            <button
                              key={val}
                              onClick={() => setDelegateInputAmount(val)}
                              className={`flex-1 py-1.5 text-[10px] font-medium rounded-lg transition ${
                                delegateInputAmount === val
                                  ? 'bg-white/15 text-white border border-white/20'
                                  : 'bg-white/5 text-white/40 hover:bg-white/10 border border-transparent'
                              }`}
                            >
                              ${val >= 1000 ? `${val/1000}k` : val}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Session Duration */}
                      <div className="mb-4">
                        <span className="text-xs text-white/50 uppercase tracking-wider block mb-2">Session Duration</span>
                        <div className="space-y-1.5">
                          <button
                            onClick={() => setSessionDuration('1h')}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition ${
                              sessionDuration === '1h'
                                ? 'border-white/20 bg-white/5'
                                : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                            }`}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40">
                              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                            </svg>
                            <span className="text-sm text-white/70">1 Hour Session</span>
                          </button>

                          <button
                            onClick={() => setSessionDuration('4h')}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition ${
                              sessionDuration === '4h'
                                ? 'border-cyan-500/50 bg-cyan-500/10'
                                : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                            }`}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={sessionDuration === '4h' ? '#06B6D4' : 'currentColor'} strokeWidth="2" className={sessionDuration === '4h' ? '' : 'text-white/40'}>
                              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                            </svg>
                            <span className={`text-sm ${sessionDuration === '4h' ? 'text-white' : 'text-white/70'}`}>4 Hour Session</span>
                            {sessionDuration !== '4h' && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-400">Recommended</span>}
                          </button>

                          <button
                            onClick={() => setSessionDuration('24h')}
                            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition ${
                              sessionDuration === '24h'
                                ? 'border-white/20 bg-white/5'
                                : 'border-white/5 hover:border-white/10 hover:bg-white/5'
                            }`}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40">
                              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
                            </svg>
                            <span className="text-sm text-white/70">24 Hour Session</span>
                          </button>
                        </div>
                      </div>

                      {/* Error Display */}
                      {(session.error || delegation.error) && (
                        <div className="mb-4 p-2 rounded-lg bg-short/10 border border-short/20 text-short text-xs">
                          {session.error || delegation.error}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex gap-2">
                        {oneClickEnabled && (
                          <button
                            onClick={async () => { await session.revokeSession(); setShowOneClickMenu(false); }}
                            disabled={session.isCreating}
                            className="flex-1 py-2.5 rounded-lg font-semibold text-sm transition border border-red-500/30 text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                          >
                            End Session
                          </button>
                        )}
                        <button
                          onClick={async () => {
                            const duration = sessionDuration === '1h' ? SESSION_DURATIONS.SHORT :
                                           sessionDuration === '24h' ? SESSION_DURATIONS.LONG :
                                           SESSION_DURATIONS.MEDIUM;
                            // First delegate if needed, then create session
                            if (delegateInputAmount > 0 && delegateInputAmount !== delegatedAmount) {
                              await delegation.approve(delegateInputAmount * 1_000_000); // Convert to smallest units
                            }
                            const success = await session.createSession(duration, true);
                            if (success) setShowOneClickMenu(false);
                          }}
                          disabled={session.isCreating || delegation.isApproving}
                          className="flex-1 py-2.5 rounded-lg font-semibold text-sm text-black transition hover:opacity-90 disabled:opacity-50"
                          style={{ backgroundColor: '#06B6D4' }}
                        >
                          {session.isCreating || delegation.isApproving ? 'Processing...' : oneClickEnabled ? 'Update Session' : 'Start Session'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
              
              {/* Balance - Pro mode */}
              {isProMode && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 bg-white/5">
                  <span className="text-xs text-white/40">BAL</span>
                  <span className="text-sm font-bold text-white">${accountBalance.toLocaleString()}</span>
                </div>
              )}
              
              {/* Rewards button - prominent */}
              <button 
                onClick={() => setShowRewardsPopup(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border transition" 
                style={{ borderColor: 'rgba(255, 184, 0, 0.3)', backgroundColor: 'rgba(255, 184, 0, 0.1)' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFB800" strokeWidth="2">
                  <path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="text-sm font-medium" style={{ color: '#FFB800' }}>Rewards</span>
              </button>
            </>
          )}
          
          {/* Wallet Connect - only when unlocked */}
          {isUnlocked && (
            connected ? (
              <div className="relative">
                <button
                  onClick={() => wallet.disconnect()}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 transition"
                  style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}
                >
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-accent to-violet flex items-center justify-center text-white text-xs font-bold">
                    {shortAddress.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-white text-sm font-mono">{shortAddress}</span>
                  {isAuthenticated && (
                    <div className="w-2 h-2 rounded-full bg-long animate-pulse" title="Authenticated" />
                  )}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setWalletModalVisible(true)}
                className="px-4 py-1.5 bg-white text-black rounded-lg text-sm font-semibold hover:bg-white/90 transition"
              >
                {isAuthenticating ? 'Signing in...' : 'Connect'}
              </button>
            )
          )}
          
          {/* Settings - only when unlocked */}
          {isUnlocked && (
            <div className="relative">
              <button 
                onClick={() => setShowSettings(!showSettings)}
                className={`w-8 h-8 rounded-lg border flex items-center justify-center transition ${showSettings ? 'border-white/30 text-white bg-white/5' : 'border-white/10 text-white/40 hover:text-white hover:border-white/20'}`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              
              {/* Settings Dropdown */}
              {showSettings && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
                  <div 
                    className="absolute right-0 top-full mt-2 w-64 rounded-xl border border-white/10 z-50 py-2"
                    style={{ backgroundColor: '#0d0d0d' }}
                  >
                    <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider">Display</div>
                    
                    {/* Pro Mode Toggle */}
                    <button 
                      onClick={toggleProMode}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Pro Mode</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${isProMode ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {isProMode && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                    
                    {/* Order Book */}
                    <button 
                      onClick={() => setShowOrderBook(!showOrderBook)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Order Book</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${showOrderBook ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {showOrderBook && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                    
                    <div className="h-px bg-white/5 my-1" />
                    
                    <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider">Chart</div>
                    
                    {/* Candlestick Chart */}
                    <button 
                      onClick={() => setChartType(chartType === 'line' ? 'candle' : 'line')}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Candlestick Chart</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${chartType === 'candle' ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {chartType === 'candle' && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                    
                    {/* Chart Tools */}
                    <button 
                      onClick={() => setShowTools(!showTools)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Chart Tools</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${showTools ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {showTools && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                    
                    {/* Show Buys and Sells */}
                    <button 
                      onClick={() => setShowBuySell(!showBuySell)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Show Buys and Sells</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${showBuySell ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {showBuySell && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                    
                    <div className="h-px bg-white/5 my-1" />
                    
                    <div className="px-3 py-1.5 text-[10px] text-white/30 uppercase tracking-wider">Audio</div>
                    
                    {/* Music */}
                    <button 
                      onClick={() => setPlayMusic(!playMusic)}
                      className="w-full px-3 py-2 flex items-center justify-between hover:bg-white/5 transition"
                    >
                      <span className="text-sm text-white/80">Music</span>
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${playMusic ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30'}`}>
                        {playMusic && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </nav>
      
      {/* ============================================ */}
      {/* ENTER CODE MODAL */}
      {/* ============================================ */}
      {showEnterCode && (
        <>
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50" onClick={() => setShowEnterCode(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md p-6 rounded-2xl border border-white/10 z-50" style={{ backgroundColor: '#0a0a0a' }}>
            <h2 className="text-xl font-bold text-white mb-2">Enter Invite Code</h2>
            <p className="text-white/50 text-sm mb-6">Get your code from an existing member or join the waitlist.</p>
            
            <input 
              type="text"
              value={inviteCode}
              onChange={(e) => { setInviteCode(e.target.value.toUpperCase()); setCodeError(''); }}
              placeholder="XXXX-XXXX-XXXX"
              className="w-full h-12 px-4 bg-white/5 border border-white/10 rounded-xl text-white text-center font-mono text-lg tracking-wider focus:outline-none focus:border-white/30 transition mb-2"
            />
            
            {codeError && (
              <p className="text-red-400 text-sm text-center mb-3">{codeError}</p>
            )}
            
            <button 
              onClick={() => handleUnlock(inviteCode)}
              className="w-full h-12 rounded-xl font-bold text-black transition hover:opacity-90 mt-2"
              style={{ backgroundColor: '#1CB955' }}
            >
              Unlock Full Access
            </button>
            
            <div className="mt-4 flex items-center justify-center gap-4">
              <button 
                onClick={() => handleUnlock('TEST')}
                className="text-white/40 text-sm hover:text-white transition"
              >
                Skip for now →
              </button>
            </div>
            
            <div className="mt-4 pt-4 border-t border-white/5 text-center">
              <button className="text-white/40 text-sm hover:text-white transition">
                Join Waitlist →
              </button>
            </div>
          </div>
        </>
      )}

      {/* ============================================ */}
      {/* HOW IT WORKS MODAL */}
      {/* ============================================ */}
      {showHowItWorks && (
        <>
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50" onClick={() => setShowHowItWorks(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg p-8 rounded-2xl border border-white/10 z-50" style={{ backgroundColor: '#0a0a0a' }}>
            <button 
              onClick={() => setShowHowItWorks(false)}
              className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/10 transition"
            >
              ✕
            </button>
            
            <h2 className="text-2xl font-bold text-white mb-2">Up or down?</h2>
            <p className="text-white/50 mb-8">That's all you need to decide.</p>
            
            <div className="space-y-6">
              {/* Step 1 */}
              <div className="flex gap-4">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black shrink-0"
                  style={{ backgroundColor: '#1CB955' }}
                >
                  1
                </div>
                <div>
                  <h3 className="text-white font-semibold mb-1">Pick a timeframe</h3>
                  <p className="text-white/50 text-sm">1 minute, 5 minutes, 15 minutes, or 1 hour. Short rounds, fast results.</p>
                </div>
              </div>
              
              {/* Step 2 */}
              <div className="flex gap-4">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black shrink-0"
                  style={{ backgroundColor: '#1CB955' }}
                >
                  2
                </div>
                <div>
                  <h3 className="text-white font-semibold mb-1">Choose your amount</h3>
                  <p className="text-white/50 text-sm">$25 to $250. Risk what you're comfortable with.</p>
                </div>
              </div>
              
              {/* Step 3 */}
              <div className="flex gap-4">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black shrink-0"
                  style={{ backgroundColor: '#1CB955' }}
                >
                  3
                </div>
                <div>
                  <h3 className="text-white font-semibold mb-1">Above or below?</h3>
                  <p className="text-white/50 text-sm">Will BTC close above or below the strike price when the timer hits zero?</p>
                </div>
              </div>
              
              {/* Step 4 */}
              <div className="flex gap-4">
                <div 
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold text-black shrink-0"
                  style={{ backgroundColor: '#1CB955' }}
                >
                  4
                </div>
                <div>
                  <h3 className="text-white font-semibold mb-1">Win up to 2x</h3>
                  <p className="text-white/50 text-sm">Get it right, double your money. Odds shift based on market sentiment.</p>
                </div>
              </div>
            </div>
            
            <div className="mt-8 pt-6 border-t border-white/5">
              <button 
                onClick={() => { setShowHowItWorks(false); setShowEnterCode(true); }}
                className="w-full py-3 rounded-xl font-bold text-black transition hover:opacity-90"
                style={{ backgroundColor: '#1CB955' }}
              >
                Get Started
              </button>
            </div>
          </div>
        </>
      )}

      {/* ============================================ */}
      {/* REWARDS POPUP */}
      {/* ============================================ */}
      {showRewardsPopup && (
        <>
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50" onClick={() => setShowRewardsPopup(false)} />
          <div 
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md rounded-2xl border border-white/10 z-50 overflow-hidden"
            style={{ backgroundColor: 'rgba(15, 15, 15, 0.98)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
              <span className="text-lg font-semibold text-white">Rewards</span>
              <button 
                onClick={() => setShowRewardsPopup(false)} 
                className="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/50 hover:text-white transition"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            
            {/* Gift Illustration */}
            <div className="flex justify-center py-8">
              <div className="relative">
                <div 
                  className="w-24 h-24 rounded-2xl flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(255, 184, 0, 0.15)' }}
                >
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#FFB800" strokeWidth="1.5">
                    <path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
                {/* Sparkles */}
                <div className="absolute -top-2 -right-2 text-lg">✨</div>
                <div className="absolute -bottom-1 -left-2 text-sm">⭐</div>
              </div>
            </div>
            
            {/* Title */}
            <div className="text-center px-6 pb-6">
              <h2 className="text-xl font-bold text-white mb-2">Invite friends. Earn $COIN.</h2>
              <p className="text-sm text-white/50">
                Share your referral code. When friends trade, you both earn rewards.
              </p>
            </div>
            
            {/* Stats */}
            <div className="mx-6 mb-6 p-4 rounded-xl bg-white/5 border border-white/10">
              <div className="flex justify-between mb-3">
                <span className="text-sm text-white/50">Friends referred</span>
                <span className="text-sm font-bold text-white">{referralsClaimed}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-sm text-white/50">Total earned</span>
                <span className="text-sm font-bold" style={{ color: '#1CB955' }}>${referralEarnings} COIN</span>
              </div>
            </div>
            
            {/* Benefits */}
            <div className="px-6 space-y-4 mb-6">
              <div className="flex gap-3">
                <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                  <span className="text-lg">🎁</span>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">10% of friend's fees</h3>
                  <p className="text-xs text-white/40">Earn 10% of trading fees from everyone you refer, forever.</p>
                </div>
              </div>
              
              <div className="flex gap-3">
                <div className="w-10 h-10 rounded-full bg-white/5 flex items-center justify-center shrink-0">
                  <span className="text-lg">♾️</span>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-white">Unlimited invites</h3>
                  <p className="text-xs text-white/40">Invite as many friends as you want. No cap on earnings.</p>
                </div>
              </div>
            </div>
            
            {/* Referral Code */}
            <div className="mx-6 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-white/40 uppercase tracking-wider">Your Referral Code</span>
              </div>
              <div className="flex gap-2">
                <div className="flex-1 h-12 bg-white/5 border border-white/10 rounded-lg flex items-center justify-center">
                  <span className="text-lg font-mono font-bold text-white tracking-wider">{referralCode}</span>
                </div>
                <button 
                  onClick={() => navigator.clipboard.writeText(referralCode)}
                  className="h-12 px-4 rounded-lg bg-white/10 hover:bg-white/15 border border-white/10 flex items-center gap-2 text-white/70 hover:text-white transition"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <span className="text-sm font-medium">Copy</span>
                </button>
              </div>
            </div>
            
            {/* Share Link */}
            <div className="px-6 pb-6">
              <button 
                onClick={() => navigator.clipboard.writeText(`https://rollions.gg/r/${referralCode}`)}
                className="w-full py-3.5 rounded-xl font-bold text-black transition hover:opacity-90"
                style={{ backgroundColor: '#FFB800' }}
              >
                Copy Invite Link
              </button>
              <button 
                className="w-full py-3 text-sm font-medium text-white/50 hover:text-white transition mt-2"
              >
                Share on Twitter
              </button>
            </div>
          </div>
        </>
      )}

      {/* ============================================ */}
      {/* MAIN CONTENT */}
      {/* ============================================ */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex-1 flex min-h-0">
          
          {/* CHART AREA */}
          <div className="flex-1 flex flex-col p-3 min-w-0">
            
            {/* PRICE LINE */}
            <div className="flex items-center gap-4 mb-1 shrink-0">
              <div className="relative">
                <button 
                  onClick={() => setShowTokenDropdown(!showTokenDropdown)}
                  className="flex items-center gap-2.5 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg transition"
                >
                  <div 
                    className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold"
                    style={{ backgroundColor: currentToken.color, color: '#fff' }}
                  >
                    {currentToken.icon}
                  </div>
                  <span className="text-white font-semibold text-lg">{currentToken.name}</span>
                  <svg width="14" height="14" viewBox="0 0 12 12" fill="none" className={`text-white/40 transition-transform ${showTokenDropdown ? 'rotate-180' : ''}`}>
                    <path d="M3 5L6 7L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                </button>
                
                {/* Token Dropdown */}
                {showTokenDropdown && (
                  <div 
                    className="absolute top-full left-0 mt-2 w-56 rounded-xl border border-white/10 z-50 overflow-hidden"
                    style={{ backgroundColor: 'rgba(15, 15, 15, 0.98)', backdropFilter: 'blur(12px)' }}
                  >
                    {tokens.map(token => (
                      <button
                        key={token.symbol}
                        onClick={() => { setSelectedToken(token.symbol); setShowTokenDropdown(false); }}
                        className={`w-full flex items-center gap-3 px-4 py-3 transition hover:bg-white/5 ${
                          selectedToken === token.symbol ? 'bg-white/5' : ''
                        }`}
                      >
                        <div 
                          className="w-8 h-8 rounded-full flex items-center justify-center text-base font-bold"
                          style={{ backgroundColor: token.color, color: '#fff' }}
                        >
                          {token.icon}
                        </div>
                        <div className="text-left">
                          <div className="text-sm font-semibold text-white">{token.name}</div>
                          <div className="text-[10px] text-white/40">{token.symbol}</div>
                        </div>
                        {selectedToken === token.symbol && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1CB955" strokeWidth="2" className="ml-auto">
                            <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              
              <span className="px-2.5 py-1 rounded text-[10px] font-bold uppercase" style={{ backgroundColor: 'rgba(28, 185, 85, 0.15)', color: '#1CB955' }}>
                0DTE
              </span>
              
              <span className="text-4xl font-bold text-white">${formatPrice(price)}</span>
              
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full" style={{ backgroundColor: isAboveStrike ? 'rgba(28, 185, 85, 0.1)' : 'rgba(233, 21, 41, 0.1)' }}>
                <span className="text-sm font-bold" style={{ color: isAboveStrike ? '#1CB955' : '#E91529' }}>
                  {strikeDistance >= 0 ? '+' : ''}{strikeDistance.toFixed(2)}% {isAboveStrike ? 'above' : 'below'}
                </span>
              </div>
            </div>

            {/* CHART */}
            <div className="flex-1 min-h-0 relative">
              <div className="absolute inset-0 rounded-xl overflow-hidden border border-white/5">
                <canvas ref={canvasRef} className="w-full h-full" />
                
                {/* Preview Mode: Question sticky above strike line + ABOVE/BELOW tags */}
                {isPreviewMode && (
                  <>
                    {/* Question - sticky above strike line */}
                    <div 
                      className="absolute left-1/2 -translate-x-1/2 z-10 transition-all duration-300"
                      style={{ top: `calc(${strikeYPosition}% - 55px)` }}
                    >
                      <div 
                        className="px-4 py-2 rounded-lg text-center"
                        style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(8px)' }}
                      >
                        <p className="text-sm font-semibold text-white whitespace-nowrap uppercase tracking-wide">
                          Will BTC close above or below{' '}
                          <span style={{ color: '#FFB800' }}>${formatPrice(strike)}</span>
                          {isMarketTransitioning ? (
                            <span className="text-amber-400 animate-pulse"> - Activating next market...</span>
                          ) : (
                            <> in <span style={{ color: '#60A5FA' }}>{formatTime(timeLeft)} min</span>?</>
                          )}
                        </p>
                      </div>
                    </div>
                    
                    {/* ABOVE tag - dimmed, text only */}
                    <div 
                      className="absolute z-10 pointer-events-none transition-all duration-300"
                      style={{ 
                        top: `calc(${strikeYPosition}% - 28px)`,
                        right: '12px'
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#1CB955" strokeWidth="3" 
                          style={{ opacity: isAboveStrike ? 0.8 : 0.3 }}>
                          <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span className="text-[10px] font-bold" 
                          style={{ color: '#1CB955', opacity: isAboveStrike ? 0.8 : 0.3 }}>
                          ABOVE
                        </span>
                      </div>
                    </div>
                    
                    {/* BELOW tag - dimmed, text only */}
                    <div 
                      className="absolute z-10 pointer-events-none transition-all duration-300"
                      style={{ 
                        top: `calc(${strikeYPosition}% + 18px)`,
                        right: '12px'
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#E91529" strokeWidth="3" 
                          style={{ opacity: !isAboveStrike ? 0.8 : 0.3 }}>
                          <path d="M12 5v14M5 12l7 7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span className="text-[10px] font-bold" 
                          style={{ color: '#E91529', opacity: !isAboveStrike ? 0.8 : 0.3 }}>
                          BELOW
                        </span>
                      </div>
                    </div>
                  </>
                )}
                
                {/* Clickable Zone Overlays - Base mode only */}
                {isBaseMode && (
                  <>
                    <div
                      className="absolute cursor-pointer transition-all hover:bg-green-500/15"
                      style={{ right: 0, width: '10%', top: '20px', bottom: '50%', borderRadius: '8px' }}
                      onClick={() => !finalCountdown && !position && !isPlacingOrder && handleTrade('above')}
                    >
                      <div className="h-full flex items-center justify-center">
                        {!position && !finalCountdown && !isPlacingOrder && (
                          <span className="text-[10px] font-bold opacity-0 hover:opacity-100 transition-opacity" style={{ color: '#1CB955' }}>
                            ↑
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      className="absolute cursor-pointer transition-all hover:bg-red-500/15"
                      style={{ right: 0, width: '10%', top: '50%', bottom: '60px', borderRadius: '8px' }}
                      onClick={() => !finalCountdown && !position && !isPlacingOrder && handleTrade('below')}
                    >
                      <div className="h-full flex items-center justify-center">
                        {!position && !finalCountdown && !isPlacingOrder && (
                          <span className="text-[10px] font-bold opacity-0 hover:opacity-100 transition-opacity" style={{ color: '#E91529' }}>
                            ↓
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                )}
                
                {/* TOOLS PANEL - Only when unlocked */}
                {isUnlocked && (
                  <div className="absolute top-3 left-3 z-10">
                    <div 
                      className="bg-black/80 backdrop-blur-sm rounded-xl border border-white/10 overflow-hidden transition-all duration-300 ease-out"
                      style={{ 
                        width: '40px',
                        maxHeight: showTools ? '300px' : '40px',
                        boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
                      }}
                    >
                      <button
                        onClick={() => setShowTools(!showTools)}
                        className="w-10 h-10 flex items-center justify-center text-white/60 hover:text-white transition"
                      >
                        <svg 
                          width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
                          className="transition-transform duration-300"
                          style={{ transform: showTools ? 'rotate(90deg)' : 'rotate(0deg)' }}
                        >
                          <path d="M3 4h10M3 8h10M3 12h10" strokeLinecap="round"/>
                        </svg>
                      </button>
                      
                      <div 
                        className="flex flex-col items-center gap-1 px-1.5 pb-2 transition-all duration-300"
                        style={{ 
                          opacity: showTools ? 1 : 0,
                          transform: showTools ? 'translateY(0)' : 'translateY(-10px)'
                        }}
                      >
                        <div className="h-px w-6 bg-white/10 mb-1" />
                        
                        <button
                          onClick={() => setChartType('line')}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center transition ${
                            chartType === 'line' ? 'bg-white text-black' : 'text-white/50 hover:text-white hover:bg-white/10'
                          }`}
                          title="Line"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M2 10L5 6L8 8L12 4" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        <button
                          onClick={() => setChartType('candle')}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center transition ${
                            chartType === 'candle' ? 'bg-white text-black' : 'text-white/50 hover:text-white hover:bg-white/10'
                          }`}
                          title="Candles"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                            <rect x="2" y="4" width="2" height="6" rx="0.5"/>
                            <rect x="6" y="2" width="2" height="8" rx="0.5"/>
                            <rect x="10" y="5" width="2" height="5" rx="0.5"/>
                          </svg>
                        </button>
                        
                        <div className="h-px w-6 bg-white/10 my-1" />
                        
                        <span className="text-[8px] text-white/30 uppercase tracking-wider">Tick</span>
                        <select
                          value={chartTick}
                          onChange={(e) => setChartTick(e.target.value)}
                          className="w-7 bg-transparent text-white/50 text-[10px] font-semibold text-center focus:outline-none cursor-pointer hover:text-white"
                          title="Tick interval"
                        >
                          {tickConfigs.map(tick => (
                            <option key={tick} value={tick} className="bg-black text-white">{tick}</option>
                          ))}
                        </select>
                        
                        <div className="h-px w-6 bg-white/10 my-1" />
                        
                        {drawingTools.map(tool => (
                          <button
                            key={tool.id}
                            onClick={() => setSelectedDrawingTool(selectedDrawingTool === tool.id ? null : tool.id)}
                            className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs transition ${
                              selectedDrawingTool === tool.id 
                                ? 'bg-white text-black' 
                                : 'text-white/50 hover:text-white hover:bg-white/10'
                            }`}
                            title={tool.label}
                          >
                            {tool.icon}
                          </button>
                        ))}
                        
                        {selectedDrawingTool && (
                          <button
                            onClick={() => setSelectedDrawingTool(null)}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-xs text-white/30 hover:text-white hover:bg-white/10 transition"
                            title="Cancel"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Market Odds Bar - Right side, Base mode only */}
                {isBaseMode && (
                  <div className="absolute top-3 right-3 z-10">
                    <div 
                      className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/10"
                      style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(8px)' }}
                    >
                      <span className="text-[10px] text-white/40 uppercase">Odds</span>
                      <span className="text-xs font-semibold" style={{ color: '#1CB955' }}>
                        {Math.round((aboveVolume / (aboveVolume + belowVolume)) * 100)}%
                      </span>
                      <div className="w-16 h-1.5 rounded-full overflow-hidden flex">
                        <div 
                          className="h-full" 
                          style={{ 
                            width: `${(aboveVolume / (aboveVolume + belowVolume)) * 100}%`,
                            backgroundColor: '#1CB955'
                          }} 
                        />
                        <div 
                          className="h-full" 
                          style={{ 
                            width: `${(belowVolume / (aboveVolume + belowVolume)) * 100}%`,
                            backgroundColor: '#E91529'
                          }} 
                        />
                      </div>
                      <span className="text-xs font-semibold" style={{ color: '#E91529' }}>
                        {Math.round((belowVolume / (aboveVolume + belowVolume)) * 100)}%
                      </span>
                    </div>
                  </div>
                )}
                
                {/* Greeks - Pro mode only, top right */}
                {isProMode && (
                  <div className="absolute top-3 right-3 z-10">
                    <div 
                      className="flex items-center gap-3 px-3 py-2 rounded-xl border border-white/10"
                      style={{ backgroundColor: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(8px)' }}
                    >
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-white/40">Δ</span>
                        <span className="text-xs font-mono text-white">{position ? (position.side === 'above' ? deltaAbove : deltaBelow) : deltaAbove}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-white/40">Θ</span>
                        <span className="text-xs font-mono" style={{ color: parseFloat(thetaValue) >= 0 ? '#1CB955' : '#E91529' }}>
                          {parseFloat(thetaValue) >= 0 ? '+' : ''}{thetaValue}/m
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-white/40">IV</span>
                        <span className="text-xs font-mono text-white">{impliedVolatility}%</span>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* ROUND INFO */}
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
                  <div 
                    className="flex items-center gap-3 px-5 py-2.5 rounded-full border"
                    style={{ 
                      backgroundColor: 'rgba(10, 10, 10, 0.95)', 
                      backdropFilter: 'blur(12px)',
                      borderColor: finalCountdown ? 'rgba(233, 21, 41, 0.5)' : 'rgba(255, 255, 255, 0.15)',
                      boxShadow: isPreviewMode ? '0 0 30px rgba(96, 165, 250, 0.15), 0 4px 20px rgba(0, 0, 0, 0.4)' : '0 4px 20px rgba(0, 0, 0, 0.3)'
                    }}
                  >
                    {/* Base mode: "This is a Xm round" + timer */}
                    {isBaseMode && (
                      <>
                        <span className="text-xs text-white font-medium whitespace-nowrap uppercase tracking-wider">
                          This is a {selectedTimeframe} round
                        </span>
                        <div className="h-4 w-px bg-white/10" />
                        <span className="text-xs text-white/40 uppercase tracking-wider whitespace-nowrap">Time left</span>
                      </>
                    )}
                    
                    {/* Pro mode: "Choose round length" + selector */}
                    {isProMode && (
                      <>
                        <span className="text-xs text-white font-medium whitespace-nowrap uppercase tracking-wider flex items-center">
                          Choose round length
                          <InfoTooltip text="How long until the round ends" />
                        </span>
                        <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-lg">
                          {Object.keys(timeframeConfigs).map((tf) => (
                            <button
                              key={tf}
                              onClick={() => handleTimeframeChange(tf)}
                              className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                                selectedTimeframe === tf 
                                  ? 'bg-white text-black' 
                                  : 'text-white/50 hover:text-white'
                              }`}
                            >
                              {tf}
                            </button>
                          ))}
                        </div>
                        <div className="h-4 w-px bg-white/10" />
                        <span className="text-xs text-white/40 uppercase tracking-wider whitespace-nowrap">Time left</span>
                      </>
                    )}
                    
                    {/* Preview mode: "ROUND LENGTH" + selector */}
                    {isPreviewMode && (
                      <>
                        <span className="text-xs text-white font-medium whitespace-nowrap uppercase tracking-wider">Round length</span>
                        <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-lg">
                          {Object.keys(timeframeConfigs).map((tf) => (
                            <button
                              key={tf}
                              onClick={() => handleTimeframeChange(tf)}
                              className={`px-2.5 py-1 rounded text-xs font-medium transition ${
                                selectedTimeframe === tf 
                                  ? 'bg-white text-black' 
                                  : 'text-white/50 hover:text-white'
                              }`}
                            >
                              {tf}
                            </button>
                          ))}
                        </div>
                        <div className="h-4 w-px bg-white/10" />
                        <span className="text-xs text-white/40 uppercase tracking-wider whitespace-nowrap">Time left</span>
                      </>
                    )}
                    
                    {/* Timer */}
                    {isMarketTransitioning ? (
                      <span className="text-sm font-medium text-amber-400 animate-pulse">
                        Activating...
                      </span>
                    ) : (
                      <>
                        <span
                          className={`text-lg font-bold tabular-nums ${finalCountdown ? 'text-red-500 animate-pulse' : ''}`}
                          style={{ color: finalCountdown ? '#E91529' : '#60A5FA' }}
                        >
                          {formatTime(timeLeft)}
                        </span>

                        {/* Progress bar */}
                        <div className="w-20 h-1.5 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full transition-all duration-1000 rounded-full"
                            style={{
                              width: `${(timeLeft / totalTime) * 100}%`,
                              backgroundColor: finalCountdown ? '#E91529' : '#60A5FA'
                            }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            {/* PRO MODE - Positions bar (chart width only) */}
            {isProMode && isUnlocked && (
              <div className="border-t border-white/10 bg-black/40 backdrop-blur-sm shrink-0 mx-3 rounded-lg mt-2">
                <div className="flex items-center justify-between px-4 border-b border-white/5">
                  {/* Tabs */}
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setShowPositions(true)}
                      className={`py-2 text-xs font-semibold border-b-2 transition ${showPositions ? 'text-white border-white' : 'text-white/40 border-transparent hover:text-white/60'}`}
                    >
                      Positions {position ? '(1)' : '(0)'}
                    </button>
                    <button 
                      onClick={() => setShowPositions(false)}
                      className={`py-2 text-xs font-semibold border-b-2 transition ${!showPositions ? 'text-white border-white' : 'text-white/40 border-transparent hover:text-white/60'}`}
                    >
                      History
                    </button>
                  </div>
                  
                  {/* Stats - always visible */}
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/40 uppercase">Win Rate</span>
                      <span className="text-xs font-semibold" style={{ color: winRate >= 50 ? '#1CB955' : '#E91529' }}>{winRate}%</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/40 uppercase">Exposure</span>
                      <span className="text-xs font-medium text-white">${currentExposure}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-white/40 uppercase">Last 5</span>
                      <div className="flex gap-1">
                        {roundHistory.map((result, i) => (
                          <span 
                            key={i} 
                            className="text-xs font-bold"
                            style={{ color: result === 'W' ? '#1CB955' : '#E91529' }}
                          >
                            {result}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                
                {showPositions ? (
                  <div className="px-4">
                    <div className="grid grid-cols-8 gap-4 py-1.5 text-[9px] text-white/30 uppercase tracking-wider border-b border-white/5">
                      <span>Side</span>
                      <span>Asset</span>
                      <span>Size</span>
                      <span>Entry</span>
                      <span>Mark</span>
                      <span>Unreal. PnL</span>
                      <span>ROE</span>
                      <span></span>
                    </div>
                    
                    {position ? (
                      <div className="grid grid-cols-8 gap-4 py-2 items-center text-xs">
                        <span className="font-bold" style={{ color: position.side === 'above' ? '#1CB955' : '#E91529' }}>
                          {position.side.toUpperCase()}
                        </span>
                        <span className="text-white/80">BTC</span>
                        <span className="text-white font-semibold">${position.size.toFixed(2)}</span>
                        <span className="text-white/60">${position.entry.toFixed(2)}</span>
                        <span className="text-white">${(position.side === 'above' ? abovePrice : belowPrice).toFixed(2)}</span>
                        {(() => {
                          const markPrice = position.side === 'above' ? abovePrice : belowPrice;
                          const currentValue = position.shares * markPrice;
                          const positionPnl = currentValue - position.size;
                          const positionPnlPercent = position.size > 0 ? (positionPnl / position.size) * 100 : 0;
                          return (
                            <>
                              <span className="font-semibold" style={{ color: positionPnl >= 0 ? '#1CB955' : '#E91529' }}>
                                {positionPnl >= 0 ? '+' : '-'}${Math.abs(positionPnl).toFixed(2)}
                              </span>
                              <span className="font-semibold" style={{ color: positionPnl >= 0 ? '#1CB955' : '#E91529' }}>
                                {positionPnlPercent >= 0 ? '+' : ''}{positionPnlPercent.toFixed(2)}%
                              </span>
                            </>
                          );
                        })()}
                        <button
                          onClick={() => handleClosePosition(position)}
                          className="px-3 py-1 border border-white/20 rounded text-[10px] font-medium transition hover:border-white/40 hover:bg-white/5 text-white/60"
                        >
                          Close
                        </button>
                      </div>
                    ) : (
                      <div className="py-3 text-center text-white/30 text-xs">No open positions</div>
                    )}
                  </div>
                ) : (
                  <div className="px-4">
                    <div className="grid grid-cols-8 gap-4 py-1.5 text-[9px] text-white/30 uppercase tracking-wider border-b border-white/5">
                      <span>Side</span>
                      <span>Asset</span>
                      <span>Size</span>
                      <span>Entry</span>
                      <span>Exit</span>
                      <span>PnL</span>
                      <span>ROE</span>
                      <span>Time</span>
                    </div>
                    
                    {displayHistory.length > 0 ? (
                      displayHistory.slice(0, 5).map((pos, i) => (
                        <div key={pos.id || i} className="grid grid-cols-8 gap-4 py-1.5 items-center text-xs border-b border-white/5 last:border-0">
                          <span className="font-bold" style={{ color: pos.side === 'above' ? '#1CB955' : '#E91529' }}>
                            {pos.side.toUpperCase()}
                          </span>
                          <span className="text-white/80">BTC</span>
                          <span className="text-white/60">${pos.size?.toFixed(2) || '0'}</span>
                          <span className="text-white/40">{pos.entry?.toFixed(2) || '-'}</span>
                          <span className="text-white/40">-</span>
                          <span style={{ color: pos.pnl >= 0 ? '#1CB955' : '#E91529' }}>
                            {pos.pnl >= 0 ? '+' : ''}${pos.pnl?.toFixed(2) || '0'}
                          </span>
                          <span style={{ color: pos.pnl >= 0 ? '#1CB955' : '#E91529' }}>
                            {pos.size ? ((pos.pnl / pos.size) * 100).toFixed(2) : '0'}%
                          </span>
                          <span className="text-white/30">{pos.closedAt || '-'}</span>
                        </div>
                      ))
                    ) : (
                      <div className="py-3 text-center text-white/30 text-xs">No trade history</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT SIDEBAR - Trading Panel */}
          <div 
            className="flex flex-col border-l border-white/5 shrink-0 overflow-y-auto"
            style={{ 
              width: isProMode ? '320px' : '320px',
              backgroundColor: 'rgba(10, 10, 10, 0.5)'
            }}
          >
            {/* ============================================ */}
            {/* PREVIEW MODE SIDEBAR */}
            {/* ============================================ */}
            {isPreviewMode && (
              <div className="p-5 flex-1 flex flex-col">
                {/* Header */}
                <div className="mb-6">
                  <h2 className="text-xl font-bold text-white mb-1">Up or down?</h2>
                  <p className="text-sm text-white/40">Pick a time. 1 to 60 minutes. Will price go up or down?</p>
                </div>
                
                {/* All 3 Steps greyed with overlay */}
                <div className="relative">
                  {/* Step 1: Choose Round Length - GREYED (moved to bottom bar) */}
                  <div className="mb-5 opacity-30">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-5 h-5 rounded-full border border-white/20 flex items-center justify-center text-[10px] text-white/30">1</span>
                      <span className="text-xs text-white/30 uppercase tracking-wider">Choose Round Length</span>
                    </div>
                    <div className="flex gap-2">
                      {Object.keys(timeframeConfigs).map((tf) => (
                        <button
                          key={tf}
                          disabled
                          className="flex-1 py-2.5 rounded-lg text-sm font-semibold bg-white/5 text-white/30 cursor-not-allowed"
                        >
                          {tf}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  {/* Step 2: Choose Amount - GREYED */}
                  <div className="mb-5 opacity-30">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-5 h-5 rounded-full border border-white/20 flex items-center justify-center text-[10px] text-white/30">2</span>
                      <span className="text-xs text-white/30 uppercase tracking-wider">Choose Amount</span>
                    </div>
                    <div className="flex gap-2">
                      {[25, 50, 100, 250].map(val => (
                        <button
                          key={val}
                          disabled
                          className="flex-1 py-2.5 text-sm font-medium rounded-lg bg-white/5 text-white/30 cursor-not-allowed"
                        >
                          ${val}
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  {/* Step 3: Place Trade - GREYED */}
                  <div className="mb-4 opacity-30">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="w-5 h-5 rounded-full border border-white/20 flex items-center justify-center text-[10px] text-white/30">3</span>
                      <span className="text-xs text-white/30 uppercase tracking-wider">Place Trade</span>
                    </div>
                    <div className="flex gap-2">
                      <button disabled className="flex-1 py-3 rounded-lg font-bold text-lg cursor-not-allowed" style={{ backgroundColor: 'rgba(28, 185, 85, 0.15)', color: '#1CB955' }}>
                        ABOVE
                      </button>
                      <button disabled className="flex-1 py-3 rounded-lg font-bold text-lg cursor-not-allowed" style={{ backgroundColor: 'rgba(233, 21, 41, 0.15)', color: '#E91529' }}>
                        BELOW
                      </button>
                    </div>
                  </div>
                  
                  {/* OVERLAY: FOMO + Enter Code link */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    {/* FOMO: Show potential return */}
                    <div 
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full mb-4"
                      style={{ 
                        backgroundColor: isAboveStrike ? 'rgba(28, 185, 85, 0.15)' : 'rgba(233, 21, 41, 0.15)'
                      }}
                    >
                      <div 
                        className="w-2 h-2 rounded-full animate-pulse"
                        style={{ backgroundColor: isAboveStrike ? '#1CB955' : '#E91529' }}
                      />
                      <span className="text-xs font-medium text-white/70">
                        $100 on <span style={{ color: isAboveStrike ? '#1CB955' : '#E91529' }}>{isAboveStrike ? 'ABOVE' : 'BELOW'}</span> → <span style={{ color: '#1CB955' }}>+$190</span>
                      </span>
                    </div>
                    
                    {/* Join Waitlist button - white */}
                    <button 
                      className="flex items-center gap-2 px-6 py-3 rounded-xl font-bold text-black transition hover:opacity-90 shadow-lg bg-white"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      Join Waitlist
                    </button>
                    <p className="text-xs text-white/40 mt-3">
                      Have a code? <button onClick={() => setShowEnterCode(true)} className="text-white/60 hover:text-white underline transition">Enter it</button>
                    </p>
                  </div>
                </div>
                
              </div>
            )}
            
            {/* ============================================ */}
            {/* BASE MODE SIDEBAR */}
            {/* ============================================ */}
            {isBaseMode && (
              <div className="p-4 flex-1 flex flex-col">
                {/* Step 1: Choose Round Length */}
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-5 h-5 rounded-full border border-white/30 flex items-center justify-center text-[10px] text-white/60">1</span>
                    <span className="text-xs text-white/70 uppercase tracking-wider flex items-center">
                      Choose Round Length
                      <InfoTooltip text="How long until the round ends" />
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {Object.keys(timeframeConfigs).map((tf) => (
                      <button
                        key={tf}
                        onClick={() => handleTimeframeChange(tf)}
                        className={`flex-1 py-2 rounded-lg text-sm font-semibold transition ${
                          selectedTimeframe === tf 
                            ? 'bg-white/10 text-white border border-white/20' 
                            : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/60 border border-transparent'
                        }`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* Step 2: Choose Amount */}
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-5 h-5 rounded-full border border-white/30 flex items-center justify-center text-[10px] text-white/60">2</span>
                    <span className="text-xs text-white/70 uppercase tracking-wider flex items-center">
                      Choose Amount
                      <InfoTooltip text="How much you want to bet on this round" />
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <button 
                      onClick={() => setAmount(Math.max(1, amount - 10))}
                      className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white transition"
                    >
                      −
                    </button>
                    <div className="flex-1 relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">$</span>
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 0))}
                        className="w-full h-10 bg-white/5 border border-white/10 rounded-lg pl-7 pr-3 text-white text-center font-bold text-lg focus:outline-none focus:border-white/30 transition"
                      />
                    </div>
                    <button 
                      onClick={() => setAmount(amount + 10)}
                      className="w-10 h-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white transition"
                    >
                      +
                    </button>
                  </div>
                  <div className="flex gap-2">
                    {[25, 50, 100, 250].map(val => (
                      <button
                        key={val}
                        onClick={() => setAmount(val)}
                        className={`flex-1 py-2 text-sm font-medium rounded-lg transition ${
                          amount === val 
                            ? 'bg-white text-black' 
                            : 'bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70'
                        }`}
                      >
                        ${val}
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* Step 3: Enter Position */}
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="w-5 h-5 rounded-full border border-white/30 flex items-center justify-center text-[10px] text-white/60">3</span>
                    <span className="text-xs text-white/70 uppercase tracking-wider flex items-center">
                      Enter Position
                      <InfoTooltip text="Predict if price will be above or below strike at round end" />
                    </span>
                  </div>
                  
                  <p className="text-sm text-white/70 mb-4 uppercase tracking-wide">
                    Will BTC close above or below{' '}
                    <span className="font-bold" style={{ color: '#FFB800' }}>${formatPrice(strike)}</span>
                    {isMarketTransitioning ? (
                      <span className="font-bold text-amber-400 animate-pulse"> - Activating next market...</span>
                    ) : (
                      <>
                        {' '}in{' '}
                        <span className="font-bold" style={{ color: '#60A5FA' }}>{formatTime(timeLeft)} min</span>?
                      </>
                    )}
                  </p>
                  
                  {/* ABOVE Button */}
                  <button
                    onClick={() => handleTrade('above')}
                    disabled={finalCountdown || position || isPlacingOrder}
                    className="relative w-full h-14 rounded-xl font-bold transition overflow-hidden group disabled:opacity-50 mb-1"
                    style={{ backgroundColor: 'rgba(28, 185, 85, 0.15)', border: '1px solid rgba(28, 185, 85, 0.3)' }}
                  >
                    <div className="relative flex items-center justify-between px-4">
                      <div className="flex items-center gap-2">
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#1CB955" strokeWidth="2.5">
                          <path d="M8 12V4M8 4L4 8M8 4L12 8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span className="text-lg font-bold" style={{ color: '#1CB955' }}>ABOVE</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-white/50">{aboveOdds}x</span>
                        <span className="text-lg font-bold" style={{ color: '#1CB955' }}>+${abovePayout}</span>
                      </div>
                    </div>
                  </button>
                  <div className="text-center text-xs text-white/40 mb-3">
                    Market price: <span className="font-semibold text-white/60">${abovePrice.toFixed(2)}</span>
                  </div>

                  {/* BELOW Button */}
                  <button
                    onClick={() => handleTrade('below')}
                    disabled={finalCountdown || position || isPlacingOrder}
                    className="relative w-full h-14 rounded-xl font-bold transition overflow-hidden group disabled:opacity-50 mb-1"
                    style={{ backgroundColor: 'rgba(233, 21, 41, 0.15)', border: '1px solid rgba(233, 21, 41, 0.3)' }}
                  >
                    <div className="relative flex items-center justify-between px-4">
                      <div className="flex items-center gap-2">
                        <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="#E91529" strokeWidth="2.5">
                          <path d="M8 4V12M8 12L4 8M8 12L12 8" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        <span className="text-lg font-bold" style={{ color: '#E91529' }}>BELOW</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-white/50">{belowOdds}x</span>
                        <span className="text-lg font-bold" style={{ color: '#E91529' }}>+${belowPayout}</span>
                      </div>
                    </div>
                  </button>
                  <div className="text-center text-xs text-white/40">
                    Market price: <span className="font-semibold text-white/60">${belowPrice.toFixed(2)}</span>
                  </div>

                  {/* Validation Error */}
                  {validationError && (
                    <div className="mt-2 p-2 rounded-lg bg-short/10 border border-short/20 text-short text-xs text-center">
                      {validationError}
                    </div>
                  )}
                </div>

                {/* Collapsible Positions Section */}
                <div className="border-t border-white/5 pt-4">
                  <button 
                    onClick={() => setShowPositions(!showPositions)}
                    className="w-full flex items-center justify-between py-2"
                  >
                    <span className="text-xs text-white/70 uppercase tracking-wider">Positions</span>
                    <svg 
                      width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
                      className={`text-white/30 transition-transform ${showPositions ? 'rotate-180' : ''}`}
                    >
                      <path d="M3 5L6 8L9 5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  {showPositions && (
                    <div className="pb-2">
                      {positionsLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                        </div>
                      ) : displayPositions.length > 0 ? (
                        <div className="space-y-2">
                          {displayPositions.map((pos, idx) => {
                            const posIsWinning = pos.side === 'above' ? isAboveStrike : !isAboveStrike;
                            const posMarkPrice = pos.side === 'above' ? abovePrice : belowPrice;
                            const posPnl = (pos.shares * posMarkPrice) - pos.size;
                            return (
                              <div
                                key={pos.marketAddress || idx}
                                className="p-3 rounded-lg"
                                style={{ backgroundColor: posIsWinning ? 'rgba(28, 185, 85, 0.1)' : 'rgba(233, 21, 41, 0.1)' }}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className="text-xs font-bold"
                                      style={{ color: pos.side === 'above' ? '#1CB955' : '#E91529' }}
                                    >
                                      {pos.side.toUpperCase()}
                                    </span>
                                    <span className="text-white/40 text-[10px]">{pos.asset || 'BTC'}</span>
                                  </div>
                                  <span className="text-white/60 text-xs">${typeof pos.size === 'number' ? pos.size.toFixed(2) : pos.size}</span>
                                </div>
                                <div className="flex items-center justify-between mb-3">
                                  <span className="text-white/40 text-xs">Entry: ${pos.optionPrice || '0.51'} → Mark: ${posMarkPrice.toFixed(2)}</span>
                                  <span
                                    className="font-bold"
                                    style={{ color: posPnl >= 0 ? '#1CB955' : '#E91529' }}
                                  >
                                    {posPnl >= 0 ? '+' : '-'}${Math.abs(posPnl).toFixed(2)}
                                  </span>
                                </div>
                                {/* Close Position Button */}
                                <button
                                  onClick={() => handleClosePosition(pos)}
                                  className="w-full py-2 rounded-lg text-xs font-semibold transition"
                                  style={{
                                    backgroundColor: posIsWinning ? 'rgba(28, 185, 85, 0.2)' : 'rgba(233, 21, 41, 0.2)',
                                    color: posIsWinning ? '#1CB955' : '#E91529',
                                    border: `1px solid ${posIsWinning ? 'rgba(28, 185, 85, 0.3)' : 'rgba(233, 21, 41, 0.3)'}`
                                  }}
                                >
                                  Close Position
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-white/30 text-sm text-center py-2">No open positions</p>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Collapsible Order Book Section */}
                <div className="border-t border-white/5 pt-2">
                  <button 
                    onClick={() => setShowOrderBook(!showOrderBook)}
                    className="w-full flex items-center justify-between py-2"
                  >
                    <span className="text-xs text-white/50 uppercase tracking-wider">Order Book</span>
                    <svg 
                      width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"
                      className={`text-white/30 transition-transform ${showOrderBook ? 'rotate-180' : ''}`}
                    >
                      <path d="M3 5L6 8L9 5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </button>
                  {showOrderBook && (
                    <div className="pb-2">
                      <div className="space-y-1 text-xs">
                        {orderBook.asks.slice().reverse().map((ask, i) => (
                          <div key={`ask-${i}`} className="relative flex justify-between px-1 py-0.5">
                            <div 
                              className="absolute inset-y-0 right-0" 
                              style={{ width: `${(ask.total / maxBookSize) * 100}%`, backgroundColor: 'rgba(28, 185, 85, 0.15)' }}
                            />
                            <span className="relative" style={{ color: '#1CB955' }}>{ask.price.toFixed(2)}</span>
                            <span className="relative text-white/50">{ask.size.toLocaleString()}</span>
                            <span className="relative text-white/30">{ask.total.toLocaleString()}</span>
                          </div>
                        ))}
                        <div className="text-center py-1 text-white/40">
                          MID: {orderBook.mid.toFixed(2)} | SPREAD: {orderBook.spread.toFixed(2)}
                        </div>
                        {orderBook.bids.map((bid, i) => (
                          <div key={`bid-${i}`} className="relative flex justify-between px-1 py-0.5">
                            <div 
                              className="absolute inset-y-0 right-0" 
                              style={{ width: `${(bid.total / maxBookSize) * 100}%`, backgroundColor: 'rgba(233, 21, 41, 0.15)' }}
                            />
                            <span className="relative" style={{ color: '#E91529' }}>{bid.price.toFixed(2)}</span>
                            <span className="relative text-white/50">{bid.size.toLocaleString()}</span>
                            <span className="relative text-white/30">{bid.total.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* ============================================ */}
            {/* PRO MODE SIDEBAR */}
            {/* ============================================ */}
            {isProMode && (
              <div className="p-4 flex-1 flex flex-col">
                {/* Order Type Toggle */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-white/50 uppercase tracking-wider flex items-center">
                      Order Type
                      <InfoTooltip text="Market: instant fill at current price. Limit: set your price" />
                    </span>
                  </div>
                  <div className="flex rounded-lg overflow-hidden border border-white/10">
                    <button
                      onClick={() => setOrderType('market')}
                      className={`flex-1 py-2 text-sm font-medium transition ${
                        orderType === 'market' 
                          ? 'bg-white/10 text-white' 
                          : 'text-white/40 hover:text-white/60'
                      }`}
                    >
                      Market
                    </button>
                    <button
                      onClick={() => setOrderType('limit')}
                      className={`flex-1 py-2 text-sm font-medium transition ${
                        orderType === 'limit' 
                          ? 'bg-white/10 text-white' 
                          : 'text-white/40 hover:text-white/60'
                      }`}
                    >
                      Limit
                    </button>
                  </div>
                  
                  {/* Limit Price Input - shown when limit selected */}
                  {orderType === 'limit' && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-white/50 uppercase tracking-wider flex items-center">
                          Limit Price
                          <InfoTooltip text="The option price you want to buy at" />
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => setLimitPrice(Math.max(0.01, limitPrice - 0.01))}
                          className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 transition"
                        >
                          −
                        </button>
                        <div className="flex-1 relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">$</span>
                          <input
                            type="number"
                            step="0.01"
                            value={limitPrice.toFixed(2)}
                            onChange={(e) => setLimitPrice(Math.max(0.01, parseFloat(e.target.value) || 0))}
                            className="w-full h-9 bg-white/5 border border-white/10 rounded-lg pl-7 pr-3 text-white text-center font-bold focus:outline-none focus:border-white/30 transition"
                          />
                        </div>
                        <button 
                          onClick={() => setLimitPrice(limitPrice + 0.01)}
                          className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 transition"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Amount */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-white/50 uppercase tracking-wider flex items-center">
                      Amount
                      <InfoTooltip text="How much you want to bet on this round" />
                    </span>
                  </div>
                  <div className="flex gap-2 mb-2">
                    {[25, 50, 100, 250].map(val => (
                      <button
                        key={val}
                        onClick={() => setAmount(val)}
                        className={`flex-1 py-1.5 text-xs font-medium rounded transition ${
                          amount === val 
                            ? 'bg-white text-black' 
                            : 'bg-white/5 text-white/50 hover:bg-white/10'
                        }`}
                      >
                        ${val}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => setAmount(Math.max(1, amount - 10))}
                      className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 transition"
                    >
                      −
                    </button>
                    <div className="flex-1 relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40 text-sm">$</span>
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(Math.max(1, parseInt(e.target.value) || 0))}
                        className="w-full h-9 bg-white/5 border border-white/10 rounded-lg pl-7 pr-3 text-white text-center font-bold focus:outline-none focus:border-white/30 transition"
                      />
                    </div>
                    <button 
                      onClick={() => setAmount(amount + 10)}
                      className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/60 hover:bg-white/10 transition"
                    >
                      +
                    </button>
                  </div>
                </div>
                
                {/* Leverage */}
                <div className="mb-4">
                  <button
                    onClick={() => setShowLeverage(!showLeverage)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-lg transition ${
                      showLeverage || leverage > 1
                        ? 'bg-cyan-500/10 text-cyan-400'
                        : 'bg-white/5 text-white/50 hover:text-white/70'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M23 6l-9.5 9.5-5-5L1 18" strokeLinecap="round" strokeLinejoin="round"/>
                        <path d="M17 6h6v6" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <span className="text-xs uppercase tracking-wider">Leverage</span>
                      {leverage > 1 && (
                        <span className="px-1.5 py-0.5 bg-cyan-500/20 rounded text-[10px] font-bold text-cyan-400">{leverage}x</span>
                      )}
                    </div>
                    <span className="text-[10px]">{showLeverage ? 'Hide' : leverage > 1 ? 'Edit' : 'Enable'}</span>
                  </button>

                  {showLeverage && (
                    <div className="mt-2 p-3 bg-white/5 rounded-lg border border-white/10">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-white/50">Multiplier</span>
                        <span className="text-lg font-bold text-cyan-400">{leverage}x</span>
                      </div>
                      <input
                        type="range"
                        value={leverage}
                        onChange={(e) => setLeverage(parseInt(e.target.value))}
                        min="1"
                        max="10"
                        step="1"
                        className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400"
                      />
                      <div className="flex justify-between text-[10px] text-white/30 mt-1">
                        <span>1x (No leverage)</span>
                        <span>10x (Max)</span>
                      </div>

                      {/* Quick leverage buttons */}
                      <div className="flex gap-1 mt-3">
                        {[1, 2, 3, 5, 10].map((lev) => (
                          <button
                            key={lev}
                            onClick={() => setLeverage(lev)}
                            className={`flex-1 py-1.5 text-[10px] rounded font-medium transition ${
                              leverage === lev
                                ? 'bg-cyan-500 text-black'
                                : 'bg-white/5 text-white/50 hover:text-white/70 hover:bg-white/10'
                            }`}
                          >
                            {lev}x
                          </button>
                        ))}
                      </div>

                      {/* Leverage info */}
                      {leverage > 1 && (
                        <div className="mt-3 pt-3 border-t border-white/10 space-y-2 text-xs">
                          <div className="flex justify-between">
                            <span className="text-white/50">Margin Required</span>
                            <span className="font-mono text-cyan-400">${leverageStats.marginRequired.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-white/50">Loan Amount</span>
                            <span className="font-mono text-white/70">${leverageStats.loanAmount.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between items-center">
                            <span className="text-white/50 flex items-center gap-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#E91529" strokeWidth="2">
                                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round"/>
                                <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round"/>
                                <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round"/>
                              </svg>
                              Liquidation Price
                            </span>
                            <span className="font-mono font-bold text-short">${leverageStats.liquidationPrice.toFixed(3)}</span>
                          </div>
                          <div className="text-[10px] bg-amber-500/10 border border-amber-500/20 rounded p-2 text-amber-400/80 mt-2">
                            <strong>Warning:</strong> With {leverage}x leverage, you can gain or lose {leverage}x faster.
                            Position will be liquidated if price reaches ${leverageStats.liquidationPrice.toFixed(3)}.
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Strike Info - all yellow, timer cyan */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium" style={{ color: '#FFB800' }}>STRIKE: ${formatPrice(strike)}</span>
                  {isMarketTransitioning ? (
                    <span className="text-sm font-medium text-amber-400 animate-pulse">Activating...</span>
                  ) : (
                    <span className="text-sm font-medium" style={{ color: '#60A5FA' }}>{formatTime(timeLeft)}</span>
                  )}
                </div>
                
                {/* ABOVE/BELOW Buttons */}
                <div className="flex gap-2 mb-4">
                  <button
                    onClick={() => handleTrade('above')}
                    disabled={finalCountdown || position || isPlacingOrder}
                    className="flex-1 py-3 rounded-lg font-bold transition disabled:opacity-50"
                    style={{ backgroundColor: 'rgba(28, 60, 40, 0.6)' }}
                  >
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-base font-bold text-white">ABOVE</span>
                        <span className="text-xs text-white/50">{aboveOdds}x</span>
                      </div>
                      <div className="text-sm" style={{ color: '#1CB955' }}>+${abovePayout}</div>
                      <div className="text-[10px] text-white/40">${abovePrice.toFixed(2)}</div>
                    </div>
                  </button>
                  <button
                    onClick={() => handleTrade('below')}
                    disabled={finalCountdown || position || isPlacingOrder}
                    className="flex-1 py-3 rounded-lg font-bold transition disabled:opacity-50"
                    style={{ backgroundColor: 'rgba(80, 20, 25, 0.6)' }}
                  >
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <span className="text-base font-bold text-white">BELOW</span>
                        <span className="text-xs text-white/50">{belowOdds}x</span>
                      </div>
                      <div className="text-sm" style={{ color: '#E91529' }}>+${belowPayout}</div>
                      <div className="text-[10px] text-white/40">${belowPrice.toFixed(2)}</div>
                    </div>
                  </button>
                </div>
                
                {/* Chain Wins */}
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-white/5">
                  <span className="text-xs text-white/50 uppercase tracking-wider flex items-center">
                    Chain Wins
                    <InfoTooltip text="Auto-compound: reinvest winnings into the next round" />
                  </span>
                  <button 
                    onClick={() => setChainWins(!chainWins)}
                    className={`w-5 h-5 rounded border-2 flex items-center justify-center transition ${
                      chainWins ? 'bg-[#1CB955] border-[#1CB955]' : 'border-white/30 hover:border-white/50'
                    }`}
                  >
                    {chainWins && (
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                        <path d="M2 6L5 9L10 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    )}
                  </button>
                </div>
                
                {/* Order Book */}
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs text-white/50 uppercase tracking-wider flex items-center">
                      Order Book
                      <InfoTooltip text="Live buy and sell orders at each price level" />
                    </span>
                    <div className="flex rounded-lg overflow-hidden border border-white/10">
                      <button
                        onClick={() => setOrderBookTab('book')}
                        className={`px-2.5 py-1 text-[10px] font-medium transition ${
                          orderBookTab === 'book' 
                            ? 'bg-white/20 text-white' 
                            : 'text-white/40 hover:text-white/60 hover:bg-white/5'
                        }`}
                      >
                        Book
                      </button>
                      <button
                        onClick={() => setOrderBookTab('trades')}
                        className={`px-2.5 py-1 text-[10px] font-medium transition ${
                          orderBookTab === 'trades' 
                            ? 'bg-white/20 text-white' 
                            : 'text-white/40 hover:text-white/60 hover:bg-white/5'
                        }`}
                      >
                        Trades
                      </button>
                    </div>
                  </div>
                  
                  {orderBookTab === 'book' ? (
                    <div className="space-y-0.5 text-xs">
                      <div className="flex justify-between text-[10px] text-white/30 uppercase px-1 pb-1">
                        <span>Price</span>
                        <span>Size</span>
                        <span>Total</span>
                      </div>
                      
                      {orderBook.asks.slice().reverse().map((ask, i) => (
                        <div key={`ask-${i}`} className="relative flex justify-between px-1 py-0.5">
                          <div 
                            className="absolute inset-y-0 right-0" 
                            style={{ width: `${(ask.total / maxBookSize) * 100}%`, backgroundColor: 'rgba(28, 185, 85, 0.2)' }}
                          />
                          <span className="relative" style={{ color: '#1CB955' }}>{ask.price.toFixed(2)}</span>
                          <span className="relative text-white/60">{ask.size.toLocaleString()}</span>
                          <span className="relative text-white/40">{ask.total.toLocaleString()}</span>
                        </div>
                      ))}
                      
                      <div className="flex items-center justify-center gap-2 py-1.5 text-[10px]">
                        <span className="text-white/50">MID: {orderBook.mid.toFixed(2)}</span>
                        <span className="text-white/20">|</span>
                        <span className="text-white/40">SPREAD: {orderBook.spread.toFixed(2)}</span>
                      </div>
                      
                      {orderBook.bids.map((bid, i) => (
                        <div key={`bid-${i}`} className="relative flex justify-between px-1 py-0.5">
                          <div 
                            className="absolute inset-y-0 right-0" 
                            style={{ width: `${(bid.total / maxBookSize) * 100}%`, backgroundColor: 'rgba(233, 21, 41, 0.2)' }}
                          />
                          <span className="relative" style={{ color: '#E91529' }}>{bid.price.toFixed(2)}</span>
                          <span className="relative text-white/60">{bid.size.toLocaleString()}</span>
                          <span className="relative text-white/40">{bid.total.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-0.5 text-xs">
                      <div className="flex justify-between text-[10px] text-white/30 uppercase px-1 pb-1">
                        <span>Price</span>
                        <span>Size</span>
                        <span>Time</span>
                      </div>
                      
                      {recentTrades.map((trade, i) => (
                        <div key={i} className="flex justify-between px-1 py-0.5">
                          <span style={{ color: trade.side === 'buy' ? '#1CB955' : '#E91529' }}>
                            {trade.price}
                          </span>
                          <span className="text-white/60">{trade.size}</span>
                          <span className="text-white/30">{trade.time}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
            
            {/* TROLLBOX - Fixed at bottom of sidebar, expands as overlay */}
            {isUnlocked && (
              <div className="relative shrink-0">
                {/* Expanded overlay - positioned above the header */}
                {chatExpanded && (
                  <div 
                    className="absolute bottom-full left-0 right-0 border-t border-white/10 z-20"
                    style={{ backgroundColor: 'rgba(10, 10, 10, 0.95)', backdropFilter: 'blur(12px)' }}
                  >
                    {/* Messages */}
                    <div className="h-48 overflow-y-auto px-3 py-2 space-y-1.5">
                      {chatMessages.map((msg, i) => (
                        <div key={i} className="text-[11px]">
                          <span className="text-white/25 mr-1.5">{msg.time}</span>
                          <span className="text-cyan-400/80 mr-1">{msg.user}:</span>
                          <span className={msg.isWin ? 'text-green-400 font-medium' : 'text-white/60'}>{msg.msg}</span>
                        </div>
                      ))}
                    </div>
                    
                    {/* Input */}
                    <div className="px-3 py-2 border-t border-white/5">
                      <div className="flex items-center gap-2">
                        <input 
                          type="text"
                          placeholder="Type..."
                          className="flex-1 bg-white/5 border border-white/10 rounded px-2 py-1 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-white/20"
                        />
                        <button className="px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px] text-white/60 transition">
                          ↵
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Header bar - always visible at bottom */}
                <div 
                  className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-white/5 transition border-t border-white/5"
                  onClick={() => setChatExpanded(!chatExpanded)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white/50 uppercase tracking-wider">Trollbox</span>
                    <div className="flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                      <span className="text-[10px] text-white/30">247</span>
                    </div>
                  </div>
                  <svg 
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" 
                    className={`text-white/30 transition-transform ${chatExpanded ? 'rotate-180' : ''}`}
                  >
                    <path d="M18 15l-6-6-6 6" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </div>
            )}
            
            {/* Connect prompt - when unlocked but not connected */}
            {isUnlocked && !connected && (
              <div className="p-4 border-t border-white/5 shrink-0">
                <button
                  onClick={() => setWalletModalVisible(true)}
                  className="w-full py-2.5 bg-white text-black rounded-xl font-bold text-sm hover:bg-white/90 transition"
                >
                  {isAuthenticating ? 'Signing in...' : 'Connect Wallet'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
