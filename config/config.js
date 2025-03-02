require('dotenv').config();

module.exports = {
  privateKey: process.env.PRIVATE_KEY,
  infuraUrl: process.env.INFURA_URL,
  tokenAddress: process.env.TOKEN_ADDRESS,
  ethAddress: process.env.ETH_ADDRESS,
  walletAddress: process.env.WALLET_ADDRESS,
  uniswapRouter: process.env.UNISWAP_ROUTER,
  amountToTrade: process.env.AMOUNT_TO_TRADE,
};
