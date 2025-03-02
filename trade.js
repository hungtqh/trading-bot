const { ethers } = require("ethers");
const { parseUnits, formatUnits } = require("ethers");
const { SMA } = require("technicalindicators");

// Uniswap V3 SwapRouter ABI (simplified)
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)"
];

// Uniswap V3 Pool ABI (simplified)
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
];

// ERC20 ABI with decimals
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)",
  "function decimals() public view returns (uint8)",
  "function balanceOf(address) view returns (uint256)"
];

// Configuration for Sepolia Testnet
const config = {
  providerUrl: "https://sepolia.infura.io/v3/",
  privateKey: "",
  swapRouterAddress: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  usdcAddress: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
  wethAddress: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
  poolAddress: "0x136759C02fBa5048B489d15B51C4fB30189a0ed4", // WETH/USDC 0.3% pool (verify!)
  feeTier: 3000,
  amountInUsd: 10,
  periodSeconds: 5, // 5 seconds for testing (originally 5 * 60)
  maPeriod: 1440,
};

// Trading Bot class
class TradingBot {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.providerUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.swapRouter = new ethers.Contract(
      config.swapRouterAddress,
      SWAP_ROUTER_ABI,
      this.wallet
    );
    this.pool = new ethers.Contract(
      config.poolAddress,
      POOL_ABI,
      this.provider
    );
    this.usdcContract = new ethers.Contract(
      config.usdcAddress,
      ERC20_ABI,
      this.wallet
    );
    this.wethContract = new ethers.Contract(
      config.wethAddress,
      ERC20_ABI,
      this.wallet
    );
    this.sma = new SMA({ period: config.maPeriod, values: [] });
    this.state = {
      prices: [],
      lastPrice: null,
      position: false,
      usdcDecimals: null, // To be fetched
      wethDecimals: null, // To be fetched
    };
    this.initializeDecimals(); // Fetch decimals on startup
  }

  // Fetch token decimals dynamically
  async initializeDecimals() {
    try {
      this.state.usdcDecimals = await this.usdcContract.decimals();
      this.state.wethDecimals = await this.wethContract.decimals();
      console.log(`USDC Decimals: ${this.state.usdcDecimals}, WETH Decimals: ${this.state.wethDecimals}`);
    } catch (error) {
      console.error("Error fetching token decimals:", error);
      this.state.usdcDecimals = 6; // Fallback
      this.state.wethDecimals = 18; // Fallback
    }
  }

  // Helper to approve a token for a specific amount
  async approveToken(tokenContract, amount) {
    try {
      const tx = await tokenContract.approve(config.swapRouterAddress, amount);
      await tx.wait();
      const decimals = tokenContract === this.usdcContract ? this.state.usdcDecimals : this.state.wethDecimals;
      console.log(`Approved SwapRouter to spend ${formatUnits(amount, decimals)} of ${tokenContract.address === config.usdcAddress ? "USDC" : "WETH"}`);
    } catch (error) {
      console.error("Error approving token:", error);
      throw error;
    }
  }

  // Fetch ETH price from Uniswap V3 pool
  async getEthPrice() {
    try {
      const slot0 = await this.pool.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;
      const Decimal0 = this.state.wethDecimals; // WETH (token0)
      const Decimal1 = this.state.usdcDecimals; // USDC (token1)
  
      // Calculate price of token0 (WETH) in terms of token1 (USDC)
      const sqrtPriceBigInt = BigInt(sqrtPriceX96.toString());
      const buyOneOfToken0BigInt = (sqrtPriceBigInt * sqrtPriceBigInt) / (BigInt(2) ** BigInt(192)); // sqrtPriceX96^2 / 2^192
      const buyOneOfToken0 = buyOneOfToken0BigInt / (10n ** Decimal1 / 10n ** Decimal0); // WETH/USDC
      
      // Calculate price of token1 (USDC) in terms of token0 (WETH)
      const buyOneOfToken1 = 1n / buyOneOfToken0; // USDC/WETH (ETH price in USD terms)
  
      console.log('buyOneOfToken0', buyOneOfToken0)
      console.log('buyOneOfToken1', buyOneOfToken1)

      // Log prices with fixed precision
      console.log("Price of WETH in USDC (WETH/USDC):", buyOneOfToken0.toFixed(Decimal1));
      console.log("Price of USDC in WETH (USDC/WETH):", buyOneOfToken1.toFixed(Decimal0));
  
      // Convert to smallest units (wei-like)
      const buyOneOfToken0Wei = BigInt(Math.floor(buyOneOfToken0 * (10 ** Decimal1))).toString();
      const buyOneOfToken1Wei = BigInt(Math.floor(buyOneOfToken1 * (10 ** Decimal0))).toString();
      console.log("Price of WETH in USDC (wei):", buyOneOfToken0Wei);
      console.log("Price of USDC in WETH (wei):", buyOneOfToken1Wei);
      console.log("");
  
      // Return USDC/WETH (ETH price in USD terms)
      return buyOneOfToken1;
    } catch (error) {
      console.error("Error fetching price from pool:", error);
      return this.state.lastPrice || 2000; // Fallback
    }
  }

  async buyWeth(amountUsd) {
    const amountIn = parseUnits(amountUsd.toString(), this.state.usdcDecimals);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    // Check USDC allowance
    const usdcAllowance = await this.usdcContract.allowance(this.wallet.address, config.swapRouterAddress);
    if (usdcAllowance < amountIn) {
      await this.approveToken(this.usdcContract, ethers.MaxUint256); // Approve max for simplicity
    }

    const tx = await this.swapRouter.exactInputSingle(
      [
        config.usdcAddress,
        config.wethAddress,
        config.feeTier,
        this.wallet.address,
        deadline,
        amountIn,
        0,
        0,
      ],
      { gasLimit: 300000 }
    );
    await tx.wait();
    console.log(`Bought WETH with $${amountUsd} USDC`);
    this.state.position = true;
  }

  async sellWeth(amountUsd) {
    const currentPrice = await this.getEthPrice(); // USDC per ETH
    const wethAmount = parseUnits((amountUsd / currentPrice).toString(), this.state.wethDecimals); // WETH needed for amountUsd USDC
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    // Check WETH balance
    const wethBalance = await this.getWethBalance();
    if (wethBalance < wethAmount) {
      console.log(`Insufficient WETH balance: ${formatUnits(wethBalance, this.state.wethDecimals)} < ${formatUnits(wethAmount, this.state.wethDecimals)}`);
      return; // Exit if not enough WETH
    }

    // Check WETH allowance
    const wethAllowance = await this.wethContract.allowance(this.wallet.address, config.swapRouterAddress);
    if (wethAllowance < wethAmount) {
      await this.approveToken(this.wethContract, ethers.MaxUint256); // Approve max for simplicity
    }

    const tx = await this.swapRouter.exactInputSingle(
      [
        config.wethAddress,
        config.usdcAddress,
        config.feeTier,
        this.wallet.address,
        deadline,
        wethAmount,
        0, // No minimum output (add slippage protection in production)
        0,
      ],
      { gasLimit: 300000 }
    );
    await tx.wait();
    console.log(`Sold ${formatUnits(wethAmount, this.state.wethDecimals)} WETH for $${amountUsd} USDC`);
    this.state.position = wethBalance > wethAmount; // Keep position if WETH remains
  }

  async getWethBalance() {
    const balance = await this.wethContract.balanceOf(this.wallet.address);
    return balance;
  }

  async run() {
    // Wait for decimals to be initialized
    while (this.state.usdcDecimals === null || this.state.wethDecimals === null) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second if decimals not ready
    }

    while (true) {
      const currentPrice = await this.getEthPrice();
      this.state.prices.push(currentPrice);

      const maValues = this.sma.nextValue(currentPrice);
      const ma = maValues !== undefined ? maValues : null;

      if (ma !== null && this.state.lastPrice !== null) {
        const crossedAbove = this.state.lastPrice <= ma && currentPrice > ma;
        const crossedBelow = this.state.lastPrice >= ma && currentPrice < ma;

        if (crossedAbove && !this.state.position) {
          console.log(`Price $${currentPrice.toFixed(2)} crossed above MA $${ma.toFixed(2)}. Buying WETH.`);
          await this.buyWeth(config.amountInUsd);
        } else if (crossedBelow && this.state.position) {
          console.log(`Price $${currentPrice.toFixed(2)} crossed below MA $${ma.toFixed(2)}. Selling WETH.`);
          await this.sellWeth(config.amountInUsd);
        }
      }
      this.state.lastPrice = currentPrice;
      console.log(`Price: $${currentPrice.toFixed(2)}, MA: $${ma ? ma.toFixed(2) : "N/A"}, Position: ${this.state.position ? "WETH" : "USDC"}`);

      await new Promise(resolve => setTimeout(resolve, config.periodSeconds * 1000));
    }
  }

  async start() {
    console.log("Starting trading bot on Sepolia with Uniswap pool price...");
    this.run().catch(console.error);
  }
}

// Run the bot
const bot = new TradingBot();
bot.start();