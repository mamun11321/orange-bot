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

    // Random User Agents list (বিভিন্ন ব্রাউজার থেকে)
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    while (attempt < maxRetries) {
        try {
            // Random User Agent নির্বাচন (প্রতি চেষ্টায় ভিন্ন ব্রাউজার)
            const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            
            logger.info(`🌐 Launching browser with User Agent: ${randomUserAgent.substring(0, 50)}...`);
            
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
                    "--disable-features=IsolateOrigins,site-per-process",
                    "--window-size=1366,768"
                ]
            });

            const page = await browser.newPage();
            
            // Set random User Agent
            await page.setUserAgent(randomUserAgent);
            
            // Set extra headers to look like real browser
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });
            
            // Set timeout
            page.setDefaultTimeout(90000);
            
            logger.info("🌐 Opening login page...");
            await page.goto("https://www.orangecarrier.com/login", {
                waitUntil: "domcontentloaded",
                timeout: 60000,
            });
            
            // Wait for page to fully load
            await page.waitForSelector("body", { timeout: 30000 });
            
            // Random delay (1-3 seconds) to mimic human behavior
            await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
            
            logger.info("⏳ Searching for login form...");
            
            // Find email field
            let emailField = null;
            let passField = null;
            
            // Try all input fields
            const inputs = await page.$$("input");
            logger.info(`Found ${inputs.length} input fields`);
            
            for (let i = 0; i < inputs.length; i++) {
                const input = inputs[i];
                const type = await input.evaluate(el => el.getAttribute("type") || "");
                const name = await input.evaluate(el => el.getAttribute("name") || "");
                const id = await input.evaluate(el => el.getAttribute("id") || "");
                const placeholder = await input.evaluate(el => el.getAttribute("placeholder") || "");
                const className = await input.evaluate(el => el.getAttribute("class") || "");
                
                logger.info(`Input ${i}: type=${type}, name=${name}, id=${id}`);
                
                // Email/Username field detection
                if (!emailField && (
                    type === "email" || 
                    type === "text" || 
                    name.toLowerCase().includes("email") || 
                    name.toLowerCase().includes("user") ||
                    id.toLowerCase().includes("email") || 
                    id.toLowerCase().includes("user") ||
                    placeholder.toLowerCase().includes("email") ||
                    placeholder.toLowerCase().includes("user")
                )) {
                    emailField = input;
                    logger.info(`✅ Found email/username field: ${name || id || placeholder}`);
                }
                
                // Password field detection
                if (!passField && (
                    type === "password" ||
                    name.toLowerCase().includes("password") ||
                    id.toLowerCase().includes("password") ||
                    placeholder.toLowerCase().includes("password")
                )) {
                    passField = input;
                    logger.info(`✅ Found password field: ${name || id || placeholder}`);
                }
            }
            
            // If still not found, try last resort
            if (!emailField || !passField) {
                const allInputs = await page.$$("input");
                for (const input of allInputs) {
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
                logger.info("✅ Email & Password fields detected!");
                
                // Clear fields first
                await emailField.click({ clickCount: 3 });
                await emailField.press('Backspace');
                
                // Type email like human (with delay)
                logger.info("✍️ Typing username...");
                for (const char of USERNAME) {
                    await emailField.type(char, { delay: Math.random() * 100 + 50 });
                }
                
                // Random delay between fields
                await new Promise(r => setTimeout(r, Math.random() * 500 + 300));
                
                // Clear and type password
                await passField.click({ clickCount: 3 });
                await passField.press('Backspace');
                
                logger.info("✍️ Typing password...");
                for (const char of PASSWORD) {
                    await passField.type(char, { delay: Math.random() * 100 + 50 });
                }
                
                // Random delay before clicking
                await new Promise(r => setTimeout(r, Math.random() * 500 + 500));
                
            } else {
                logger.error("❌ Could not detect login form fields");
                throw new Error("Could not detect email or password field!");
            }

            // Find and click login button
            let loginBtn = null;
            
            // Try different button selectors
            const buttonSelectors = [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:contains("Sign In")',
                'button:contains("Login")',
                'button:contains("Signin")'
            ];
            
            for (const selector of buttonSelectors) {
                if (selector.includes('contains')) {
                    const btns = await page.$$('button');
                    for (const btn of btns) {
                        const text = await btn.evaluate(el => el.innerText);
                        if (text && (text.includes("Sign In") || text.includes("Login") || text.includes("Signin"))) {
                            loginBtn = btn;
                            break;
                        }
                    }
                } else {
                    loginBtn = await page.$(selector);
                }
                if (loginBtn) break;
            }

            if (loginBtn) {
                logger.info("👉 Clicking Sign In button...");
                await loginBtn.click();
            } else {
                logger.info("No login button found, pressing Enter key...");
                await passField.press('Enter');
            }
            
            // Wait for navigation
            await new Promise(r => setTimeout(r, 5000));
            
            const currentUrl = page.url();
            logger.info(`📍 Current URL after login: ${currentUrl}`);
            
            // Check if login successful
            if (!currentUrl.includes("login") && currentUrl.includes("orangecarrier.com")) {
                const pageContent = await page.content();
                if (pageContent.includes("Dashboard") || 
                    pageContent.includes("Account Code") || 
                    pageContent.includes("Live Calls") || 
                    pageContent.includes("logout") ||
                    pageContent.includes("Welcome")) {
                    
                    logger.info("🎉 Login successful! Dashboard detected.");
                    
                    // Take screenshot for verification
                    await page.screenshot({ path: 'dashboard.png' }).catch(() => {});
                    
                    const liveCallsUrl = "https://www.orangecarrier.com/live/calls";
                    await page.goto(liveCallsUrl, { waitUntil: "networkidle2", timeout: 30000 });
                    const cookies = await page.cookies();
                    
                    logger.info(`✅ Session established with ${cookies.length} cookies`);
                    
                    return { browser, page, cookies };
                }
            }
            
            // Check if still on login page
            if (currentUrl.includes("login")) {
                const pageContent = await page.content();
                if (pageContent.includes("invalid") || pageContent.includes("Incorrect") || pageContent.includes("error")) {
                    logger.error("❌ Login failed: Invalid credentials");
                } else {
                    logger.error("❌ Login failed: Still on login page");
                }
                throw new Error("Login failed - still on login page");
            }
            
            throw new Error("Login failed or dashboard not detected.");
            
        } catch (err) {
            attempt++;
            logger.error(`❌ Login attempt ${attempt} failed: ${err.message}`);
            
            if (browser) {
                await browser.close();
                browser = null;
            }
            
            if (attempt >= maxRetries) {
                logger.error("🔴 Could not login after multiple attempts.");
                return null;
            }
            
            const waitTime = 8000;
            logger.info(`🔄 Retrying login in ${waitTime/1000} seconds...`);
            await new Promise(r => setTimeout(r, waitTime));
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