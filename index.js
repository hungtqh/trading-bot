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

// ERC20 ABI for approval
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) public returns (bool)",
  "function allowance(address owner, address spender) public view returns (uint256)"
];

// Configuration for Sepolia Testnet
const config = {
    providerUrl: "https://sepolia.infura.io/v3/",
    privateKey: "",
    swapRouterAddress: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
    usdcAddress: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8", //  0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
    wethAddress: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14",
    poolAddress: "0x9799b5edc1aa7d3fad350309b08df3f64914e244", // WETH/USDC 0.3% pool (verify!)
    feeTier: 3000,
    amountInUsd: 10,
    periodSeconds: 5, // 5 * 60
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
    };
  }

  // Approve SwapRouter to spend USDC and WETH
  async approveSwapRouter() {
    try {
      const maxUint256 = ethers.MaxUint256;

      // Check current allowances
      const usdcAllowance = await this.usdcContract.allowance(this.wallet.address, config.swapRouterAddress);
      const wethAllowance = await this.wethContract.allowance(this.wallet.address, config.swapRouterAddress);

      // Approve USDC if not already approved
      if (usdcAllowance < maxUint256) {
        const usdcTx = await this.usdcContract.approve(config.swapRouterAddress, maxUint256);
        await usdcTx.wait();
        console.log("Approved SwapRouter to spend USDC");
      } else {
        console.log("USDC already approved for SwapRouter");
      }

      // Approve WETH if not already approved
      if (wethAllowance < maxUint256) {
        const wethTx = await this.wethContract.approve(config.swapRouterAddress, maxUint256);
        await wethTx.wait();
        console.log("Approved SwapRouter to spend WETH");
      } else {
        console.log("WETH already approved for SwapRouter");
      }
    } catch (error) {
      console.error("Error approving SwapRouter:", error);
      throw error;
    }
  }

  // Fetch ETH price from Uniswap V3 pool
  async getEthPrice() {
    try {
      const slot0 = await this.pool.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;

      const sqrtPriceBigInt = BigInt(sqrtPriceX96.toString());
      const priceBigInt = (sqrtPriceBigInt * sqrtPriceBigInt * BigInt(10 ** (18 - 6))) / (BigInt(2) ** BigInt(192));
      const price = Number(priceBigInt) / 10 ** 18; // ETH/USDC
      return 1 / price; // USDC/ETH (ETH price in USD terms)
    } catch (error) {
      console.error("Error fetching price from pool:", error);
      return this.state.lastPrice || 2000; // Fallback
    }
  }

  async buyWeth(amountUsd) {
    const amountIn = parseUnits(amountUsd.toString(), 6);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    const tx = await this.swapRouter.exactInputSingle(
      [
        config.usdcAddress,
        config.wethAddress,
        config.feeTier,
        this.wallet.address,
        // deadline,
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

  async sellWeth() {
    const wethBalance = await this.getWethBalance();
    // const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    const tx = await this.swapRouter.exactInputSingle(
      [
        config.wethAddress,
        config.usdcAddress,
        config.feeTier,
        this.wallet.address,
        // deadline,
        wethBalance,
        0,
        0,
      ],
      { gasLimit: 300000 }
    );
    await tx.wait();
    console.log(`Sold all WETH for USDC`);
    this.state.position = false;
  }

  async getWethBalance() {
    const wethContract = new ethers.Contract(
      config.wethAddress,
      ["function balanceOf(address) view returns (uint256)"],
      this.wallet
    );
    const balance = await wethContract.balanceOf(this.wallet.address);
    return balance;
  }

  async run() {
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
          await this.sellWeth();
        }
      }
      await this.buyWeth(config.amountInUsd);
      this.state.lastPrice = currentPrice;
      console.log(`Price: $${currentPrice.toFixed(2)}, MA: $${ma ? ma.toFixed(2) : "N/A"}, Position: ${this.state.position ? "WETH" : "USDC"}`);

      await new Promise(resolve => setTimeout(resolve, config.periodSeconds * 1000));
    }
  }

  async start() {
    console.log("Starting trading bot on Sepolia with Uniswap pool price...");
    await this.approveSwapRouter(); // Approve tokens before running
    this.run().catch(console.error);
  }
}

// Run the bot
const bot = new TradingBot();
bot.start();