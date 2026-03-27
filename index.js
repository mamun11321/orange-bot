import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import axios from 'axios';
import winston from 'winston';
import fs from 'fs';
import path from 'path';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import { COUNTRY_FLAGS, COUNTRY_NAME_TO_CODE } from './countries.js';
import {
    USERNAME,
    PASSWORD,
    BOT_TOKEN,
    CHAT_ID,
    REFRESH_INTERVAL_MINUTES,
    MAIN_CHANNEL_NAME,
    MAIN_CHANNEL_URL,
    ADMIN_NAME,
    ADMIN_URL
} from './env.js';

ffmpeg.setFfmpegPath(ffmpegPath);

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(info => `${info.timestamp} - ${info.level.toUpperCase()}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'bot_log.txt', level: 'info' })
    ]
});

const getCountryFlag = (countryName) => {
    const countryNameUpper = countryName.trim().toUpperCase();
    const countryCode = COUNTRY_NAME_TO_CODE[countryNameUpper];
    return COUNTRY_FLAGS[countryCode] || '🌍';
};

const maskNumber = (number) => {
    const numStr = String(number).trim();
    return numStr.length > 7
        ? `${numStr.substring(0, 3)}***${numStr.substring(numStr.length - 4)}`
        : numStr;
};

const extractCountryFromTermination = (text) => {
    const parts = text.split(' ');
    const countryParts = [];
    for (const part of parts) {
        if (['MOBILE', 'FIXED'].includes(part.toUpperCase()) || /\d/.test(part)) {
            break;
        }
        countryParts.push(part);
    }
    return countryParts.length > 0 ? countryParts.join(' ') : text;
};

const sendAudioToTelegramGroup = async (caption, filePath) => {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`;
    const form = new FormData();
    form.append('chat_id', CHAT_ID);
    form.append('caption', caption);
    form.append('audio', fs.createReadStream(filePath));
    form.append('reply_markup', JSON.stringify({
        inline_keyboard: [
            [
                { text: `📢 ${MAIN_CHANNEL_NAME}`, url: MAIN_CHANNEL_URL },
                { text: `👮 ${ADMIN_NAME}`, url: ADMIN_URL }
            ]
        ]
    }));

    try {
        await axios.post(url, form, { headers: form.getHeaders(), timeout: 30000 });
        logger.info("✔️ Audio file sent to Telegram successfully.");
    } catch (e) {
        logger.error(`❌ Failed to send audio file: ${e.response?.data?.description || e.message}`);
    }
};

const closePopups = async (page) => {
    const popupTexts = ['Next', 'Done', 'Close', 'Skip', 'Got it'];
    for (const text of popupTexts) {
        try {
            const btn = await page.$x(`//button[contains(text(), '${text}')]`);
            if (btn.length > 0) {
                await btn[0].click();
                logger.info(`✅ Closed popup: ${text}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        } catch (e) {}
    }
};

// ============================================
// লগইন ফাংশন - সঠিক URL সহ
// ============================================
const loginToDashboard = async ({ headless = true, maxRetries = 3 } = {}) => {
    let browser = null;
    let attempt = 0;

    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    ];

    while (attempt < maxRetries) {
        try {
            const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            
            logger.info(`🚀 Launching browser (headless: ${headless})...`);
            
            browser = await puppeteer.launch({
                headless,
                defaultViewport: { width: 1366, height: 768 },
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-accelerated-2d-canvas",
                    "--disable-gpu",
                    "--disable-web-security",
                    "--window-size=1366,768",
                    "--disable-blink-features=AutomationControlled"
                ],
                protocolTimeout: 120000
            });

            const page = await browser.newPage();
            
            await page.setUserAgent(randomUserAgent);
            
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });
            
            page.setDefaultTimeout(90000);
            
            // ✅ সঠিক URL - orangecarrier.com (দুটি 'r')
            const LOGIN_URL = "https://www.orangecarrier.com/login";
            const LIVE_CALLS_URL = "https://www.orangecarrier.com/live/calls";
            
            logger.info(`🌐 Opening login page: ${LOGIN_URL}`);
            await page.goto(LOGIN_URL, {
                waitUntil: "networkidle2",
                timeout: 60000,
            });
            
            // Screenshot for debugging
            await page.screenshot({ path: 'login-page.png' }).catch(() => {});
            
            await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));
            
            logger.info("🔍 Finding login form...");
            
            let emailField = await page.$('input[type="email"], input[name="email"]');
            if (!emailField) {
                const inputs = await page.$$('input');
                for (const input of inputs) {
                    const name = await input.evaluate(el => el.name);
                    if (name === 'email') {
                        emailField = input;
                        break;
                    }
                }
            }
            
            let passField = await page.$('input[type="password"]');
            
            if (!emailField || !passField) {
                throw new Error("Login form fields not found!");
            }
            
            logger.info("✅ Email & Password fields detected!");
            
            // Type email
            await emailField.click({ clickCount: 3 });
            await emailField.press('Backspace');
            logger.info("✍️ Typing username...");
            for (const char of USERNAME) {
                await emailField.type(char, { delay: Math.random() * 100 + 80 });
            }
            
            await new Promise(r => setTimeout(r, 800));
            
            // Type password
            await passField.click({ clickCount: 3 });
            await passField.press('Backspace');
            logger.info("✍️ Typing password...");
            for (const char of PASSWORD) {
                await passField.type(char, { delay: Math.random() * 100 + 80 });
            }
            
            await new Promise(r => setTimeout(r, 1000));
            
            // Click login button
            let loginBtn = await page.$('button[type="submit"]');
            if (!loginBtn) loginBtn = await page.$('input[type="submit"]');
            
            if (loginBtn) {
                logger.info("👉 Clicking Sign In button...");
                await loginBtn.click();
            } else {
                logger.info("⏎ Pressing Enter...");
                await passField.press('Enter');
            }
            
            // Wait for redirect
            logger.info("⏳ Waiting for redirect...");
            await new Promise(r => setTimeout(r, 8000));
            
            // Check current URL
            const currentUrl = page.url();
            logger.info(`📍 Current URL after login: ${currentUrl}`);
            
            // Check if login successful (URL should not be /login)
            if (currentUrl.includes('/login')) {
                // Still on login page - check for error
                const pageContent = await page.content();
                if (pageContent.includes('invalid') || pageContent.includes('incorrect')) {
                    logger.error("❌ Invalid credentials!");
                } else {
                    logger.error("❌ Login failed - still on login page");
                }
                throw new Error("Login failed - still on login page");
            }
            
            // Navigate to live calls
            logger.info("🌐 Navigating to live calls...");
            await page.goto(LIVE_CALLS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
            
            await closePopups(page);
            
            const finalUrl = page.url();
            logger.info(`📍 Final URL: ${finalUrl}`);
            
            if (finalUrl.includes('live/calls')) {
                logger.info("🎉 Login successful! On live calls page.");
                const cookies = await page.cookies();
                logger.info(`🍪 Got ${cookies.length} cookies`);
                
                // Send start message
                const startMsg = `✅ Orange Carrier Bot Started!\n🕒 Time: ${new Date().toLocaleString()}\n🍪 Cookies: ${cookies.length}\n📡 Monitoring live calls...`;
                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: CHAT_ID,
                    text: startMsg,
                    parse_mode: 'HTML'
                }).catch(e => logger.error(`Telegram: ${e.message}`));
                
                return { browser, page, cookies };
            }
            
            throw new Error(`Login failed - unexpected URL: ${finalUrl}`);
            
        } catch (err) {
            attempt++;
            logger.error(`❌ Login attempt ${attempt} failed: ${err.message}`);
            if (browser) await browser.close();
            browser = null;
            if (attempt >= maxRetries) return null;
            logger.info(`🔄 Retrying in 10 seconds...`);
            await new Promise(r => setTimeout(r, 10000));
        }
    }
    return null;
};

const processCallWorker = async (callData, cookies, page) => {
    const { country, number, cliNumber, audioUrl } = callData;

    try {
        const fileName = `call_${Date.now()}_${cliNumber}.wav`;
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const filePath = path.join(__dirname, fileName);

        const headers = {
            Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        };

        const response = await axios.get(audioUrl, {
            headers,
            responseType: "arraybuffer",
            timeout: 30000,
        });

        fs.writeFileSync(filePath, Buffer.from(response.data), "binary");
        logger.info(`🎧 Audio file downloaded (WAV): ${fileName}`);

        const filePathMp3 = filePath.replace(".wav", ".mp3");
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .audioCodec("libmp3lame")
                .toFormat("mp3")
                .on("end", () => {
                    logger.info(`🔄 Converted to MP3: ${path.basename(filePathMp3)}`);
                    resolve();
                })
                .on("error", (err) => {
                    logger.error(`❌ FFmpeg conversion error: ${err.message}`);
                    reject(err);
                })
                .save(filePathMp3);
        });

        const caption = `${getCountryFlag(country)} *Country*: ${country}\n📞 *Number*: ${maskNumber(number)}\n▶️ Play audio for OTP`;

        await sendAudioToTelegramGroup(caption, filePathMp3);

        fs.unlinkSync(filePath);
        fs.unlinkSync(filePathMp3);
        logger.info("🗑️ Temporary files deleted.");
    } catch (e) {
        logger.error(`❌ Error processing call for ${cliNumber}: ${e.message}`);
    }
};

const main = async () => {
    let browser = null;
    let currentPage = null;
    let reconnectAttempts = 0;
    
    const startMonitoring = async () => {
        try {
            const session = await loginToDashboard({ headless: true, maxRetries: 3 });
            if (!session) {
                logger.error("🔴 Could not login after multiple attempts.");
                return false;
            }

            browser = session.browser;
            currentPage = session.page;
            const cookies = session.cookies;

            const processedCalls = new Set();
            logger.info("\n🚀 Monitoring started...");

            const refreshInterval = setInterval(async () => {
                if (!currentPage || currentPage.isClosed()) {
                    logger.warn("⚠️ Page is closed, reconnecting...");
                    clearInterval(refreshInterval);
                    await reconnect();
                    return;
                }
                
                try {
                    logger.info(`🕒 ${REFRESH_INTERVAL_MINUTES} minutes passed. Refreshing...`);
                    await currentPage.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                    await closePopups(currentPage);
                    logger.info("✅ Page refreshed.");
                } catch (e) {
                    logger.error(`🔴 Refresh failed: ${e.message}`);
                    clearInterval(refreshInterval);
                    await reconnect();
                }
            }, REFRESH_INTERVAL_MINUTES * 60 * 1000);

            while (true) {
                try {
                    if (!currentPage || currentPage.isClosed()) {
                        throw new Error("Page is closed");
                    }
                    
                    const pageHtml = await currentPage.content();
                    const $ = cheerio.load(pageHtml);

                    const rows = $('#LiveCalls tr, #last-activity tbody.lastdata tr, table tbody tr');
                    
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        const columns = $(row).find('td');
                        if (columns.length > 2) {
                            const cliNumber = $(columns[2]).text().trim();
                            
                            if (cliNumber && /^\d+$/.test(cliNumber) && !processedCalls.has(cliNumber)) {
                                processedCalls.add(cliNumber);
                                
                                const msg = `📞 <b>New Call Detected!</b>\n🔢 Number: <code>${cliNumber}</code>\n⏳ Playing in 20 seconds...`;
                                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                    chat_id: CHAT_ID,
                                    text: msg,
                                    parse_mode: 'HTML'
                                }).catch(() => {});
                                
                                logger.info(`📞 New call: ${cliNumber}`);
                                
                                const playButton = $(row).find("button[onclick*='Play']");
                                if (playButton.length) {
                                    const onclickAttr = playButton.attr('onclick');
                                    const matches = onclickAttr.match(/Play\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/);
                                    if (matches) {
                                        const [, did, uuid] = matches;
                                        
                                        const callData = {
                                            country: extractCountryFromTermination($(columns[0]).text().trim()),
                                            number: $(columns[1]).text().trim(),
                                            cliNumber: cliNumber,
                                            audioUrl: `https://www.orangecarrier.com/live/calls/sound?did=${did}&uuid=${uuid}`
                                        };
                                        
                                        const currentCookies = await currentPage.cookies();
                                        
                                        setTimeout(() => {
                                            processCallWorker(callData, currentCookies, currentPage)
                                                .catch(err => logger.error(`❌ Call failed: ${err.message}`));
                                        }, 20000);
                                    }
                                }
                            }
                        }
                    }

                } catch (e) {
                    if (e.message.includes('detached') || e.message.includes('closed')) {
                        logger.error(`🔴 Frame error: ${e.message}`);
                        throw e;
                    } else {
                        logger.error(`🔴 Loop error: ${e.message}`);
                        await new Promise(r => setTimeout(r, 15000));
                    }
                }

                await new Promise(r => setTimeout(r, 2000));
            }

        } catch (e) {
            logger.error(`🔴 Monitoring error: ${e.message}`);
            return false;
        }
    };
    
    const reconnect = async () => {
        logger.info("🔄 Reconnecting...");
        if (browser) {
            try { await browser.close(); } catch (e) {}
            browser = null;
        }
        
        reconnectAttempts++;
        if (reconnectAttempts > 5) {
            logger.error("🔴 Too many reconnect attempts. Exiting.");
            process.exit(1);
        }
        
        await new Promise(r => setTimeout(r, 10000));
        await startMonitoring();
    };
    
    await startMonitoring();
};

main();