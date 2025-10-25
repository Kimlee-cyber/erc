require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { ethers } = require('ethers');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ETH_RPC = process.env.ETH_RPC_URL || 'https://cloudflare-eth.com';
const COINGECKO_KEY = process.env.COINGECKO_API_KEY || '';

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Set TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const provider = new ethers.JsonRpcProvider(ETH_RPC);

// Minimal ERC-20 ABI fragments
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

function isPossibleAddress(text) {
  // quick check for 0x... and length 42 (address)
  return typeof text === 'string' && text.trim().startsWith('0x') && text.trim().length === 42;
}

async function fetchOnchainTokenInfo(address) {
  const contract = new ethers.Contract(address, ERC20_ABI, provider);
  const info = {};
  // try each call, some tokens may not implement them correctly
  try { info.name = await contract.name(); } catch (e) { info.name = null; }
  try { info.symbol = await contract.symbol(); } catch (e) { info.symbol = null; }
  try { info.decimals = await contract.decimals(); } catch (e) { info.decimals = null; }
  return info;
}

async function fetchPriceFromCoinGecko(address) {
  const url = `https://api.coingecko.com/api/v3/simple/token_price/ethereum`;
  const params = {
    contract_addresses: address,
    vs_currencies: 'usd'
  };
  const headers = {};
  if (COINGECKO_KEY) headers['x-cg-pro-api-key'] = COINGECKO_KEY;
  const res = await axios.get(url, { params, headers, timeout: 10000 });
  // response keys are lowercased checksum or lower address; normalize
  const key = Object.keys(res.data)[0];
  if (!key) return null;
  return res.data[key].usd ?? null;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // quick help
  if (text === '/start' || text === '/help') {
    return bot.sendMessage(chatId, 'Send an Ethereum token contract address (0x...) and I will fetch name, symbol, decimals and USD price (if listed).');
  }

  if (!isPossibleAddress(text)) {
    return bot.sendMessage(chatId, 'Please send a valid Ethereum contract address (0x... length 42).');
  }

  // validate address properly using ethers
  if (!ethers.isAddress(text)) {
    return bot.sendMessage(chatId, 'This does not look like a valid Ethereum address.');
  }

  const address = ethers.getAddress(text); // checksummed

  const loadingMsg = await bot.sendMessage(chatId, `Fetching info for ${address} ...`);

  try {
    const [onchain, priceUsd] = await Promise.all([
      fetchOnchainTokenInfo(address),
      fetchPriceFromCoinGecko(address).catch(() => null)
    ]);

    let reply = `🔎 Token info for ${address}\n\n`;
    reply += `Name: ${onchain.name ?? '—'}\n`;
    reply += `Symbol: ${onchain.symbol ?? '—'}\n`;
    reply += `Decimals: ${onchain.decimals ?? '—'}\n`;
    reply += `Price (USD): ${priceUsd !== null ? `$${priceUsd}` : 'Not listed / unknown'}\n\n`;
    reply += `Chart/search: https://www.coingecko.com/en/coins/ \n(Use the token page or search the symbol if CoinGecko didn't return a price.)`;

    await bot.editMessageText(reply, { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error fetching token info:', err?.message || err);
    await bot.editMessageText('Failed to fetch token info. The token contract might be nonstandard or the network provider failed.', { chat_id: chatId, message_id: loadingMsg.message_id });
  }
});
