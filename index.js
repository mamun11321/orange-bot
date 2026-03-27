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

const loginToDashboard = async ({ headless = true, maxRetries = 3 } = {}) => {
    let browser = null;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            browser = await puppeteer.launch({
                headless,
                defaultViewport: null,
                args: [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-accelerated-2d-canvas",
                    "--disable-gpu"
                ]
            });

            const page = await browser.newPage();
            
            // Set timeout
            page.setDefaultTimeout(60000);
            
            logger.info("🌐 Opening login page...");
            await page.goto("https://www.orangecarrier.com/login", {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            
            // Extra wait for dynamic content
            await page.waitForSelector("input, form", { timeout: 30000 }).catch(() => {});
            
            logger.info("⏳ Waiting for form to load...");
            await new Promise(r => setTimeout(r, 3000));

            // Try multiple selectors for email field
            let emailField = null;
            let passField = null;
            
            // Try different selectors
            const emailSelectors = [
                'input[type="email"]',
                'input[name="email"]',
                'input[name="username"]',
                'input[id*="email"]',
                'input[placeholder*="Email"]',
                'input[placeholder*="email"]'
            ];
            
            const passSelectors = [
                'input[type="password"]',
                'input[name="password"]',
                'input[id*="password"]',
                'input[placeholder*="Password"]',
                'input[placeholder*="password"]'
            ];
            
            for (const selector of emailSelectors) {
                emailField = await page.$(selector);
                if (emailField) break;
            }
            
            for (const selector of passSelectors) {
                passField = await page.$(selector);
                if (passField) break;
            }
            
            // If still not found, try generic approach
            if (!emailField || !passField) {
                const inputs = await page.$$("input");
                for (const input of inputs) {
                    const type = await input.evaluate(el => el.getAttribute("type"));
                    if (!emailField && (type === "email" || type === "text")) {
                        emailField = input;
                    }
                    if (!passField && type === "password") {
                        passField = input;
                    }
                }
            }

            if (emailField && passField) {
                logger.info("✅ Email & Password fields detected! Auto filling...");
                await emailField.type(USERNAME, { delay: 50 });
                await passField.type(PASSWORD, { delay: 50 });
            } else {
                logger.error("❌ Could not detect login form fields");
                throw new Error("Could not detect email or password field!");
            }

            // Try to find login button
            let loginBtn = await page.$("button[type=submit]");
            if (!loginBtn) loginBtn = await page.$("input[type=submit]");
            if (!loginBtn) {
                const btns = await page.$$("button");
                for (const btn of btns) {
                    const text = await btn.evaluate(el => el.innerText);
                    if (text && (text.includes("Sign In") || text.includes("Login") || text.includes("Signin"))) {
                        loginBtn = btn;
                        break;
                    }
                }
            }

            if (loginBtn) {
                logger.info("👉 Clicking Sign In button...");
                await Promise.all([
                    loginBtn.click(),
                    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null),
                ]);
            } else {
                throw new Error("Sign In button not found!");
            }

            // Wait for redirect
            await new Promise(r => setTimeout(r, 3000));
            
            const currentUrl = page.url();
            logger.info(`📍 Current URL: ${currentUrl}`);
            
            if (currentUrl.includes("orangecarrier.com") && !currentUrl.includes("login")) {
                const pageContent = await page.content();
                if (pageContent.includes("Dashboard") || pageContent.includes("Account Code") || pageContent.includes("Live Calls")) {
                    logger.info("🎉 Login successful! Dashboard detected.");

                    const liveCallsUrl = "https://www.orangecarrier.com/live/calls";
                    await page.goto(liveCallsUrl, { waitUntil: "networkidle2" });
                    const cookies = await page.cookies();

                    return { browser, page, cookies };
                }
            }

            throw new Error("Login failed or dashboard not detected.");
        } catch (err) {
            attempt++;
            logger.error(`❌ Login attempt ${attempt} failed: ${err.message}`);
            if (browser) await browser.close();
            browser = null;
            if (attempt >= maxRetries) return null;
            logger.info("🔄 Retrying login...");
            await new Promise(r => setTimeout(r, 5000));
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
            "User-Agent": "Mozilla/5.0",
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
    try {
        const session = await loginToDashboard({ headless: true, maxRetries: 3 });
        if (!session) {
            logger.error("🔴 Could not login after multiple attempts.");
            return;
        }

        browser = session.browser;
        const page = session.page;
        const cookies = session.cookies;

        const processedCalls = new Set();
        logger.info("\n🚀 Monitoring started...");

        setInterval(async () => {
            logger.info(`🕒 ${REFRESH_INTERVAL_MINUTES} minutes passed. Refreshing page...`);
            try {
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                logger.info("✅ Page refreshed successfully.");
            } catch (e) {
                logger.error(`🔴 Page refresh failed: ${e.message}`);
            }
        }, REFRESH_INTERVAL_MINUTES * 60 * 1000);

        while (true) {
            try {
                const pageHtml = await page.content();
                const $ = cheerio.load(pageHtml);

                $('#LiveCalls tr, #last-activity tbody.lastdata tr').each((i, row) => {
                    const columns = $(row).find('td');
                    if (columns.length > 2) {
                        const cliNumber = $(columns[2]).text().trim();

                        const playButton = $(row).find("button[onclick*='Play']");
                        if (playButton.length) {
                            const onclickAttr = playButton.attr('onclick');
                            const matches = onclickAttr.match(/Play\(['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\)/);
                            if (matches) {
                                const [, did, uuid] = matches;
                                const callId = `${cliNumber}_${uuid}`;

                                if (!processedCalls.has(callId)) {
                                    processedCalls.add(callId);

                                    const callData = {
                                        country: extractCountryFromTermination($(columns[0]).text().trim()),
                                        number: $(columns[1]).text().trim(),
                                        cliNumber: cliNumber,
                                        audioUrl: `https://www.orangecarrier.com/live/calls/sound?did=${did}&uuid=${uuid}`
                                    };

                                    logger.info(`📞 New call detected (${cliNumber}), scheduling playback after 20s...`);

                                    setTimeout(() => {
                                        processCallWorker(callData, cookies, page)
                                            .catch(err => logger.error(`❌ Call processing failed for ${cliNumber}: ${err.message}`));
                                    }, 20000);
                                }
                            }
                        }
                    }
                });

            } catch (e) {
                logger.error(`🔴 Unexpected error in monitoring loop: ${e.message}`);
                await new Promise(resolve => setTimeout(resolve, 15000));
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

    } catch (e) {
        logger.error(`🔴 Browser or driver crashed! Error: ${e.message}`);
    } finally {
        if (browser) {
            logger.info("Stopping the bot.");
            await browser.close();
        }
    }
};

main();