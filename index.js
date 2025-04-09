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
const SMA = process.env.SMA;
const PERIOD = process.env.PERIOD;

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

function formatIST(date) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(date);
}

async function checkAndApproveToken(tokenAddress, spender, amountInEth) {
    try {
      // Get token decimals
      const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
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
  
function calculateMovingAverage(prices, period) {
    if (prices.length < period) return null;
    const slice = prices.slice(-period);
    return slice.reduce((sum, price) => sum + price, 0) / period;
}

async function executeTrade(action, amountInUSDC) {
    const tokenContract = new ethers.Contract(TOKEN_ADDRESS, erc20Abi, wallet);
    const tokenDecimals = await tokenContract.decimals();
    const amountIn = parseUnits(amountInUSDC.toString(), tokenDecimals);
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
  
    let tx;
  
    if (action === 'SELL') {
      const currentPrice = await getCurrentPrice();
      const requiredEth = (amountInUSDC * currentPrice).toFixed(18);
      const amountInETH = parseEther(requiredEth.toString());
      await checkAndApproveToken(WETH_ADDRESS, UNISWAP_V3_ROUTER_ADDRESS, amountInETH);
  
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
  
      tx = await routerContract.exactInputSingle(params, { gasLimit: 350000 });
    } else if (action === 'BUY') {
      await checkAndApproveToken(TOKEN_ADDRESS, UNISWAP_V3_ROUTER_ADDRESS, amountIn);
  
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
  
    // Calculate Gas Fee
    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.gasPrice || tx.gasPrice; 
    const gasFeeETH = parseFloat(ethers.formatEther(gasUsed * effectiveGasPrice));
  
    return {
      txHash: receipt.hash,
      gasFeeETH
    };
}
  
async function tradingStrategy() {
  let entryPrice = 0;
  let bought = false;
  let profitCounter = 0;
  let canTrade = true;

  const tradeAmountUSDC = parseFloat(process.env.AMOUNT_TO_TRADE);
  const duration = PERIOD * 60 * 1000;
  const TAKE_PROFIT_PERCENT = parseFloat(process.env.TAKE_PROFIT_PERCENT) / 100;
  const SMA_OFFSET = parseFloat(process.env.SMA_OFFSET) / 100;
  const PROFIT_COUNT_LIMIT = parseInt(process.env.PROFIT_COUNT);
  const swapFeeRate = parseFloat(FEE_PERCENT) / 1_000_000;

  while (true) {
    try {
      const currentPrice = await getCurrentPrice();
      priceHistory.push(currentPrice);
      if (priceHistory.length > 100) priceHistory.shift();

      const ma = calculateMovingAverage(priceHistory, SMA);
      if (!ma) {
        await sleep(duration);
        continue;
      }

      const smaOffsetValue = ma * SMA_OFFSET;
      const upperBand = ma + smaOffsetValue;
      const lowerBand = ma - smaOffsetValue;

      console.log(`Price: ${currentPrice}, MA: ${ma}, Bands: [${lowerBand}, ${upperBand}]`, formatIST(new Date()));

      // BUY logic
      if (canTrade && !bought && currentPrice > upperBand) {
        const { txHash, gasFeeETH } = await executeTrade('BUY', tradeAmountUSDC);
        entryPrice = currentPrice;
        bought = true;
        profitCounter = 0;

        const buyFee = entryPrice * tradeAmountUSDC * swapFeeRate;
        console.log(`BUY at ${entryPrice}, Tx: ${txHash}, Gas: ${gasFeeETH}, Fee: ${buyFee.toFixed(6)}`, formatIST(new Date()));
      }

      // SELL logic (either take-profit or SMA cross)
      if (bought) {
        const shouldTakeProfit = currentPrice >= entryPrice * (1 + TAKE_PROFIT_PERCENT) && profitCounter < PROFIT_COUNT_LIMIT;
        const shouldExit = currentPrice < ma;

        if (shouldTakeProfit || shouldExit) {
          const { txHash, gasFeeETH } = await executeTrade('SELL', tradeAmountUSDC);

          const grossProfitETH = (currentPrice - entryPrice) * tradeAmountUSDC;
          const buySwapFeeETH = entryPrice * tradeAmountUSDC * swapFeeRate;
          const sellSwapFeeETH = currentPrice * tradeAmountUSDC * swapFeeRate;
          const totalSwapFeeETH = buySwapFeeETH + sellSwapFeeETH;
          const netProfitETH = grossProfitETH - gasFeeETH - totalSwapFeeETH;

          const reason = shouldTakeProfit ? 'Take-Profit' : 'Exit on SMA-cross';

          console.log(`${reason} SELL at ${currentPrice}, Tx: ${txHash}, Gas: ${gasFeeETH}`, formatIST(new Date()));
          console.log(`Gross: ${grossProfitETH.toFixed(6)}, SwapFee: ${totalSwapFeeETH.toFixed(6)}, Net: ${netProfitETH.toFixed(6)}`);

          bought = false;
          canTrade = false;
          if (shouldTakeProfit) profitCounter += 1;
        }
      }

      // Enable re-entry once price returns to range
      if (!canTrade && currentPrice >= lowerBand && currentPrice <= upperBand) {
        canTrade = true;
        console.log(`Re-entry zone entered. Trading enabled.`, formatIST(new Date()));
      }

      await sleep(duration);
    } catch (err) {
      console.error('Error in trading strategy:', err.message);
      await sleep(duration);
    }
  }
}

// Helper function to sleep for a given duration
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Start the strategy
tradingStrategy().catch(console.error);
