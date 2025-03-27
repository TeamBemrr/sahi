const puppeteer = require('puppeteer');
const { setIntervalAsync } = require('set-interval-async/fixed');
const { clearIntervalAsync } = require('set-interval-async');
const fs = require('fs/promises');
const axios = require('axios');

const CONFIG = {
  groqApiKey: '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',
  websiteUrl: 'https://sahi.com/sahi-buzz?date=Today',
  wpApiUrl: 'https://profitbooking.in/wp-json/scraper/v1/sahi_article',
  companyList: 'companies.json',
  groqModel: 'deepseek-r1-distill-llama-70b',
  apiInterval: 30000,
  maxRetries: 3,
  maxPages: 7,
  scrollDelay: 200,
  pageLoadDelay: 3000
};

class NewsProcessor {
    constructor() {
      this.queue = [];
      this.isProcessing = false;
      this.validNSC = new Set();
      this.invalidIndicators = new Set(['NOT SPECIFIED', 'N/A', 'NA', '']);
    }
  
    async loadCompanies() {
      try {
        const data = await fs.readFile(CONFIG.companyList);
        const companies = JSON.parse(data);
        
        if (!Array.isArray(companies)) {
          throw new Error('Invalid company list format');
        }
  
        this.validNSC = new Set(
          companies
            .filter(c => c.nsc && c.name)
            .map(c => c.nsc.toUpperCase())
        );
        console.log(`📋 Loaded ${this.validNSC.size} valid company codes`);
      } catch (error) {
        console.error('Company loading failed:', error);
        this.validNSC = new Set();
      }
    }
  
    async processQueue() {
      if (this.isProcessing || this.queue.length === 0) return;
      
      this.isProcessing = true;
      const article = this.queue.shift();
      
      try {
        console.log('🔄 Processing:', article.title.substring(0, 50) + '...');
        const result = await this.queryGroq(`${article.title} ${article.description}`);
        
        if (result) {
          await this.storeInWordPress({
            ...result,
            source: article.source,
            date: article.date
          });
        } else {
          console.log('⏩ Skipping: No valid company data found');
        }
      } catch (error) {
        console.error('❌ Processing error:', error.message);
      } finally {
        this.isProcessing = false;
      }
    }
  
    async queryGroq(text) {
      const companyList = this.validNSC.size > 0 
        ? `Valid NSCs: ${Array.from(this.validNSC).join(', ')}. `
        : '';
  
      const cleanText = text
        .substring(0, 1500)
        .replace(/[^\w\s.,-]/g, '')
        .replace(/\s+/g, ' ');
  
      for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
          const response = await axios.post(
            'https://api.groq.com/openai/v1/chat/completions',
            {
              model: CONFIG.groqModel,
              messages: [{
                role: "user",
                content: `${companyList} Analyze news article and create JSON response:
                {
                  "company_name": "string",
                  "headline": "string",
                  "description": "string",
                  "nsc": "uppercase NSC symbol",
                  "confidence": 0.0-1.0,
                  "news_date": "YYYY-MM-DD"
                } Return NULL if no company found. Text: ${cleanText}`
              }],
              temperature: 0.1,
              response_format: { type: "json_object" }
            },
            {
              headers: {
                'Authorization': `Bearer ${CONFIG.groqApiKey}`,
                'Content-Type': 'application/json'
              },
              timeout: 15000
            }
          );
          return this.parseResponse(response);
        } catch (error) {
          console.error(`Attempt ${attempt} failed:`, error.response?.data?.error?.message || error.message);
          await new Promise(resolve => setTimeout(resolve, 15000));
        }
      }
      return null;
    }
  
    parseResponse(response) {
      try {
        const rawData = JSON.parse(response.data.choices[0].message.content);
        const nsc = rawData.nsc?.toUpperCase().trim();
        
        if (!nsc || !this.validNSC.has(nsc)) {
          console.log('⚠️ Invalid/Missing NSC:', nsc || 'undefined');
          return null;
        }
  
        const requiredFields = ['company_name', 'headline', 'confidence'];
        if (!requiredFields.every(field => rawData[field])) {
          console.log('⏩ Skipping: Missing required fields');
          return null;
        }
  
        return {
          company_name: rawData.company_name,
          headline: rawData.headline,
          description: rawData.description || '',
          nsc: nsc,
          confidence: Math.min(1, Math.max(0, rawData.confidence)),
          news_date: this.validateDate(rawData.news_date)
        };
      } catch (error) {
        console.error('🔴 Response parsing failed:', error.message);
        return null;
      }
    }
  
    validateDate(dateString) {
      try {
        return new Date(dateString).toISOString().split('T')[0];
      } catch {
        return new Date().toISOString().split('T')[0];
      }
    }
  
    async storeInWordPress(data) {
      try {
        const payload = {
          title: data.headline,
          description: data.description,
          source: data.source,
          company: data.company_name,
          nsc: data.nsc,
          confidence: data.confidence,
          // news_date: data.news_date,
          news_date: new Date().toISOString().split('T')[0]
        };
  
        const response = await axios.post(CONFIG.wpApiUrl, payload, {
          timeout: 60000
        });
  
        if (response.data?.id) {
          console.log(`✅ Stored: ${data.nsc} - ${data.company_name}`);
        } else {
          console.log('⚠️ Server rejected:', response.data);
        }
      } catch (error) {
        console.error('🔴 Storage failed:', error.response?.data?.message || error.message);
      }
    }
  }

async function autoScroll(page) {
  await page.evaluate(async (scrollDelay) => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if(totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, scrollDelay);
    });
  }, CONFIG.scrollDelay);
}

async function scrapePage(page) {
  await autoScroll(page);
  
  return page.evaluate(() => {
    const items = [];
    const articleSelector = '.bg-surface-neutral-l1-dark > div'; // Original selector
    document.querySelectorAll(articleSelector).forEach(el => {
      const title = el.querySelector('h3')?.textContent?.trim();
      const description = el.querySelector('p')?.textContent?.trim();
      if(title && description) {
        items.push({
          title,
          description,
          category: el.querySelector('.text-sunrise-800')?.textContent?.trim() || 'General',
          time: el.querySelector('.text-neutral-tertiary-dark')?.textContent?.trim() || 'N/A',
          source: 'Sahi Buzz'
        });
      }
    });
    return items;
  });
}

async function main() {
  let browser;
  let interval;
  
  try {
    const processor = new NewsProcessor();
    await processor.loadCompanies();

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    let currentPage = 1;
    let totalArticles = 0;

    while (currentPage <= CONFIG.maxPages) {
      const pageUrl = currentPage === 1 
        ? CONFIG.websiteUrl 
        : `${CONFIG.websiteUrl}&page=${currentPage}`;

      console.log(`🌐 Navigating to page ${currentPage}: ${pageUrl}`);
      
      try {
        await page.goto(pageUrl, {
          waitUntil: 'networkidle2',
          timeout: 60000
        });

        const newsItems = await scrapePage(page);
        
        if(newsItems.length === 0) {
          console.log('⏹ No articles found, stopping pagination');
          break;
        }

        processor.queue.push(...newsItems);
        totalArticles += newsItems.length;
        console.log(`📥 Page ${currentPage} added ${newsItems.length} articles (Total: ${totalArticles})`);

        // Check for next page
        const hasNextPage = await page.evaluate(() => {
          const nextBtn = document.querySelector('a[aria-label="Next page"]');
          return nextBtn && !nextBtn.disabled;
        });

        if(!hasNextPage) break;

        currentPage++;
        await new Promise(resolve => setTimeout(resolve, CONFIG.pageLoadDelay));
        
      } catch (pageError) {
        console.error(`❌ Error processing page ${currentPage}:`, pageError.message);
        break;
      }
    }

    console.log(`🚀 Starting processing of ${totalArticles} articles`);
    interval = setIntervalAsync(
      () => processor.processQueue(),
      CONFIG.apiInterval
    );

    while (processor.queue.length > 0 || processor.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('🏁 All articles processed successfully');
    
  } catch (error) {
    console.error('🔥 Critical error:', error);
  } finally {
    if (browser) await browser.close();
    if (interval) await clearIntervalAsync(interval);
    process.exit(0);
  }
}

main();