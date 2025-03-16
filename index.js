const { ethers, parseEther } = require('ethers');
const IUniswapV3PoolABI = require('@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json');
const IUniswapV3Router = require('@uniswap/v3-periphery/artifacts/contracts/interfaces/ISwapRouter.sol/ISwapRouter.json');
require("dotenv").config();

// // Tetnet Configuration
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

const routerContract = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, IUniswapV3Router.abi, wallet);
const poolContract = new ethers.Contract(POOL_ADDRESS, IUniswapV3PoolABI.abi, provider);

// Price history array
let priceHistory = [];

async function initializePoolData() {
    const token0 = await poolContract.token0();
    const token1 = await poolContract.token1();
    return {
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        isWethToken1: token1.toLowerCase() === WETH_ADDRESS.toLowerCase()
    };
}

async function getCurrentPrice() {
    try {
      const { token0, token1, isWethToken1 } = await initializePoolData();
      const slot0 = await poolContract.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;
  
      // Set decimals explicitly (USDC: 6 decimals, WETH: 18 decimals)
      const decimalsToken0 = token0 === WETH_ADDRESS.toLowerCase() ? 18 : 6;
      const decimalsToken1 = token1 === WETH_ADDRESS.toLowerCase() ? 18 : 6;
  
      // Correct formula using BigInt for precision
      const price = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  
      // Adjust decimals properly
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

async function executeTrade(action, amountInEth) {
    const amountIn = parseEther(amountInEth.toString());
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20; // 20 minutes

    let tx;
    if (action === 'BUY') {
        const params = {
            tokenIn: WETH_ADDRESS,
            tokenOut: TOKEN_ADDRESS,
            fee: FEE_PERCENT,
            recipient: WALLET_ADDRESS,
            deadline: deadline,
            amountIn: amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        };
        tx = await routerContract.exactInputSingle(params, { value: amountIn, gasLimit: 350000 });
    } else if (action === 'SELL') {
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
    const tradeAmount = process.env.AMOUNT_TO_TRADE; // 0.0001 ETH
    const duration = 300000; // 5 minutes

    while (true) {
        try {
            const currentPrice = await getCurrentPrice();
            console.log('CurrentPrice USDC/WETH', currentPrice);
            priceHistory.push(currentPrice);

            if (priceHistory.length > 100) {
                priceHistory.shift();
            }

            const ma5 = calculateMovingAverage(priceHistory);
            if (!ma5) {
                await new Promise(resolve => setTimeout(resolve, duration));
                continue;
            }

            console.log(`Price: ${currentPrice}, MA5: ${ma5}`);
            if (!positionOpen && currentPrice > ma5) {
                const txHash = await executeTrade('BUY', tradeAmount);
                console.log(`Buy executed at ${currentPrice}. Tx: ${txHash}`);
                positionOpen = true;
            } else if (positionOpen && currentPrice < ma5) {
                const txHash = await executeTrade('SELL', tradeAmount);
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