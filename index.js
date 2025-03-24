const { ethers, parseEther, parseUnits } = require('ethers');
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json');
const IUniswapV3Router = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json');
require("dotenv").config();

// Tetnet Configuration
// const UNISWAP_V3_ROUTER_ADDRESS = '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E';
// const WETH_ADDRESS = '0xfff9976782d46cc05630d1f6ebab18b2324d6b14';
// const TOKEN_ADDRESS = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; // USDC
// const POOL_ADDRESS = '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1'; // WETH-USDC 0.05% pool

// Configuration
const INFURA_URL = process.env.RPC_URL;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;
const UNISWAP_V3_ROUTER_ADDRESS = process.env.UNISWAP_V3_ROUTER_ADDRESS;

// Token setup (WETH/USDC)
const WETH_ADDRESS = process.env.WETH_ADDRESS;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS; // USDC
const POOL_ADDRESS = process.env.POOL_ADDRESS; // WETH-USDC 0.05% pool
const FEE_PERCENT = process.env.FEE_PERCENT;

// Initialize provider and contracts
const provider = new ethers.JsonRpcProvider(INFURA_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Testnet only
// const routerAbi = ['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'];
const erc20Abi = [
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function decimals() external view returns (uint8)'
];
const routerContract = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, IUniswapV3Router.abi, wallet);
const poolContract = new ethers.Contract(POOL_ADDRESS, IUniswapV3PoolABI.abi, provider);
const tokenContract = new ethers.Contract(TOKEN_ADDRESS, erc20Abi, wallet);

// Price history array
let priceHistory = [];

async function initializePoolData() {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
  
    // Fetch token decimals dynamically
    const token0Contract = new ethers.Contract(token0, erc20Abi, provider);
    const token1Contract = new ethers.Contract(token1, erc20Abi, provider);
    
    const decimalsToken0 = Number(await token0Contract.decimals());
    const decimalsToken1 = Number(await token1Contract.decimals());
  
    return {
      decimalsToken0,
      decimalsToken1,
      isWethToken1: token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
    };
}

async function checkAndApproveToken(spender, amountInEth) {
    try {
      // Get token decimals
      const decimals = await tokenContract.decimals();
  
      // Convert ETH to Token amount using currentPrice
      const amountInTokens = parseUnits(amountInEth.toString(), decimals);
  
      // Check existing allowance
      const allowance = await tokenContract.allowance(WALLET_ADDRESS, spender);
  
      if (allowance < amountInTokens) {
        console.log(`Insufficient allowance: ${allowance}. Approving MAX_UINT256`);
        const tx = await tokenContract.approve(spender, ethers.MaxUint256);
        await tx.wait();
        console.log(`Approval successful.`);
      } else {
        console.log(`Sufficient allowance. No need to approve.`);
      }
  
      return amountInTokens;
    } catch (error) {
      console.error("Approval check failed:", error.message);
    }
  }

async function getCurrentPrice() {
    try {
      const { decimalsToken0, decimalsToken1, isWethToken1 } = await initializePoolData();
  
      // Get sqrtPriceX96 from the pool
      const slot0 = await poolContract.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;
  
      // Convert sqrtPriceX96 to a floating-point price using BigInt for precision
      const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  
      // Adjust for token decimals
      const decimalAdjustment = 10 ** (decimalsToken0 - decimalsToken1);
      const adjustedPrice = price * decimalAdjustment;
  
      // If token0 is WETH, invert the price
      const finalPrice = isWethToken1 ? adjustedPrice : 1 / adjustedPrice;
  
      return finalPrice;
    } catch (error) {
      console.error('Price fetch error:', error.message);
      return 0;
    }
}
  
function calculateMovingAverage(prices, period = 5) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((sum, price) => sum + price, 0) / period;
}

async function executeTrade(action, amountInUSDC) {
    const tokenDecimals = await tokenContract.decimals();
    const amountIn = parseUnits(amountInUSDC.toString(), tokenDecimals);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

    let tx;

    if (action === 'BUY') {
        // Get current price to calculate approximate ETH amount required
        const currentPrice = await getCurrentPrice();
        const requiredEth = (amountInUSDC * currentPrice).toFixed(18);
        const amountInETH = parseEther(requiredEth.toString());

        const params = {
            tokenIn: WETH_ADDRESS,
            tokenOut: TOKEN_ADDRESS,
            fee: FEE_PERCENT,
            recipient: WALLET_ADDRESS,
            deadline: deadline,
            amountIn: amountInETH,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        };

        tx = await routerContract.exactInputSingle(params, { value: amountInETH, gasLimit: 350000 });
    } else if (action === 'SELL') {
        await checkAndApproveToken(UNISWAP_V3_ROUTER_ADDRESS, amountInUSDC);

        const params = {
            tokenIn: TOKEN_ADDRESS,
            tokenOut: WETH_ADDRESS,
            fee: FEE_PERCENT,
            recipient: WALLET_ADDRESS,
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        };

        tx = await routerContract.exactInputSingle(params, { gasLimit: 350000 });
    }

    const receipt = await tx.wait();
    return receipt.hash;
}

async function tradingStrategy() {
    let positionOpen = false;
    const tradeAmountUSDC = process.env.AMOUNT_TO_TRADE;
    const duration = 300000;

    while (true) {
        try {
            const currentPrice = await getCurrentPrice();
            console.log('CurrentPrice USDC/WETH', currentPrice);

            priceHistory.push(currentPrice);
            if (priceHistory.length > 100) priceHistory.shift();

            const ma5 = calculateMovingAverage(priceHistory);
            if (!ma5) {
                await new Promise(resolve => setTimeout(resolve, duration));
                continue;
            }

            console.log(`Price: ${currentPrice}, MA5: ${ma5}`);

            if (!positionOpen && currentPrice > ma5) {
                const txHash = await executeTrade('BUY', tradeAmountUSDC);
                console.log(`Buy executed at ${currentPrice}. Tx: ${txHash}`);
                positionOpen = true;
            } else if (positionOpen && currentPrice < ma5) {
                const txHash = await executeTrade('SELL', tradeAmountUSDC);
                console.log(`Sell executed at ${currentPrice}. Tx: ${txHash}`);
                positionOpen = false;
            }

            await new Promise(resolve => setTimeout(resolve, duration));
        } catch (error) {
            console.error('Error:', error.message);
            await new Promise(resolve => setTimeout(resolve, duration));
        }
    }
}

// Start the strategy
tradingStrategy().catch(console.error);