// ============================================
// মেইন ফাংশন - সম্পূর্ণ রিকানেক্ট সিস্টেম সহ
// ============================================
const main = async () => {
    let browser = null;
    let currentPage = null;
    let reconnectAttempts = 0;
    let isRunning = true;
    
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

            // Refresh interval with proper error handling
            let refreshInterval = null;
            
            const setupRefreshInterval = () => {
                if (refreshInterval) clearInterval(refreshInterval);
                
                refreshInterval = setInterval(async () => {
                    if (!isRunning) return;
                    
                    try {
                        // Check if page is still valid
                        if (!currentPage || currentPage.isClosed()) {
                            logger.warn("⚠️ Page is closed, stopping refresh interval");
                            clearInterval(refreshInterval);
                            return;
                        }
                        
                        // Check if page is still connected
                        await currentPage.evaluate(() => document.title).catch(() => {
                            throw new Error("Page disconnected");
                        });
                        
                        logger.info(`🕒 ${REFRESH_INTERVAL_MINUTES} minutes passed. Refreshing page...`);
                        await currentPage.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                        await closePopups(currentPage);
                        logger.info("✅ Page refreshed successfully.");
                        
                    } catch (e) {
                        logger.error(`🔴 Refresh failed: ${e.message}`);
                        clearInterval(refreshInterval);
                        // Trigger reconnect
                        throw new Error("Refresh failed - need reconnect");
                    }
                }, REFRESH_INTERVAL_MINUTES * 60 * 1000);
                
                return refreshInterval;
            };
            
            let interval = setupRefreshInterval();

            // Main monitoring loop with frame recovery
            while (isRunning) {
                try {
                    // Check if page is still valid
                    if (!currentPage || currentPage.isClosed()) {
                        throw new Error("Page is closed or null");
                    }
                    
                    // Try a simple operation to check if frame is still attached
                    await currentPage.evaluate(() => document.title).catch((e) => {
                        if (e.message.includes('detached Frame')) {
                            throw new Error('Frame detached - need reconnect');
                        }
                        throw e;
                    });
                    
                    const pageHtml = await currentPage.content();
                    const $ = cheerio.load(pageHtml);

                    // Find table rows
                    const rows = $('#LiveCalls tr, #last-activity tbody.lastdata tr, table tbody tr');
                    
                    let hasNewCalls = false;
                    
                    for (let i = 0; i < rows.length; i++) {
                        const row = rows[i];
                        const columns = $(row).find('td');
                        if (columns.length > 2) {
                            const cliNumber = $(columns[2]).text().trim();
                            
                            if (cliNumber && /^\d+$/.test(cliNumber) && !processedCalls.has(cliNumber)) {
                                processedCalls.add(cliNumber);
                                hasNewCalls = true;
                                
                                // Send Telegram notification
                                const msg = `📞 <b>New Call Detected!</b>\n🔢 Number: <code>${cliNumber}</code>\n⏳ Playing audio in 20 seconds...`;
                                axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                    chat_id: CHAT_ID,
                                    text: msg,
                                    parse_mode: 'HTML'
                                }).catch(() => {});
                                
                                logger.info(`📞 New call detected (${cliNumber}), scheduling playback after 20s...`);
                                
                                // Find and click play button
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
                                        
                                        // Get fresh cookies
                                        let currentCookies = [];
                                        try {
                                            currentCookies = await currentPage.cookies();
                                        } catch (e) {
                                            logger.warn(`Could not get cookies: ${e.message}`);
                                            currentCookies = cookies;
                                        }
                                        
                                        setTimeout(() => {
                                            processCallWorker(callData, currentCookies, currentPage)
                                                .catch(err => logger.error(`❌ Call processing failed: ${err.message}`));
                                        }, 20000);
                                    }
                                }
                            }
                        }
                    }
                    
                    if (!hasNewCalls) {
                        // Small delay to prevent CPU overload
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }

                } catch (e) {
                    const errorMsg = e.message || String(e);
                    
                    if (errorMsg.includes('detached Frame') || 
                        errorMsg.includes('closed') || 
                        errorMsg.includes('Protocol error') ||
                        errorMsg.includes('Session closed') ||
                        errorMsg.includes('Target closed')) {
                        
                        logger.error(`🔴 Frame detached: ${errorMsg}`);
                        logger.info("🔄 Attempting to recover...");
                        
                        // Clean up interval
                        if (refreshInterval) clearInterval(refreshInterval);
                        
                        // Throw to trigger reconnect
                        throw new Error("Frame detached - reconnect needed");
                        
                    } else {
                        logger.error(`🔴 Unexpected error: ${errorMsg}`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
            }

        } catch (e) {
            logger.error(`🔴 Monitoring error: ${e.message}`);
            return false;
        }
        return true;
    };
    
    const reconnect = async () => {
        logger.info("🔄 Attempting to reconnect...");
        
        // Close old browser
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                logger.warn(`Error closing browser: ${e.message}`);
            }
            browser = null;
        }
        
        currentPage = null;
        reconnectAttempts++;
        
        if (reconnectAttempts > 5) {
            logger.error("🔴 Too many reconnect attempts (5). Exiting.");
            process.exit(1);
        }
        
        const waitTime = Math.min(30000, reconnectAttempts * 10000);
        logger.info(`⏳ Waiting ${waitTime/1000} seconds before reconnecting...`);
        await new Promise(r => setTimeout(r, waitTime));
        
        // Reset reconnect attempts on success
        const success = await startMonitoring();
        if (success) {
            reconnectAttempts = 0;
            logger.info("✅ Successfully reconnected!");
        } else {
            logger.error("❌ Reconnection failed");
            // Try again
            await reconnect();
        }
    };
    
    // Start with error handling wrapper
    const runWithReconnect = async () => {
        try {
            await startMonitoring();
        } catch (e) {
            if (e.message && (e.message.includes('detached') || e.message.includes('closed'))) {
                logger.warn(`⚠️ Caught error: ${e.message}`);
                await reconnect();
                await runWithReconnect();
            } else {
                logger.error(`❌ Fatal error: ${e.message}`);
                process.exit(1);
            }
        }
    };
    
    await runWithReconnect();
};