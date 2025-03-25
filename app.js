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
  wpUser: 'your_wp_username',
  wpPass: 'your_wp_password'
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
            timeout: 60000
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
        news_date: data.news_date
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

async function main() {
  let interval;
  try {
    const processor = new NewsProcessor();
    await processor.loadCompanies();
    
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.goto(CONFIG.websiteUrl, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    const newsItems = await page.evaluate(() => 
      Array.from(document.querySelectorAll('.bg-surface-neutral-l1-dark > div')).map(el => ({
        title: el.querySelector('h3')?.textContent?.trim() || '',
        description: el.querySelector('p')?.textContent?.trim() || '',
        category: el.querySelector('.text-sunrise-800')?.textContent?.trim() || '',
        time: el.querySelector('.text-neutral-tertiary-dark')?.textContent?.trim() || '',
        source: 'Sahi Buzz'
      })).filter(item => item.title && item.description)
    );

    processor.queue.push(...newsItems);
    console.log('📥 Queue loaded with', newsItems.length, 'articles');

    interval = setIntervalAsync(
      () => processor.processQueue(),
      CONFIG.apiInterval
    );

    while (processor.queue.length > 0 || processor.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await browser.close();
    if (interval) {
      await clearIntervalAsync(interval);
    }
    console.log('🏁 Processing completed');
    process.exit(0);
  } catch (error) {
    console.error('🔥 Critical error:', error);
    if (interval) {
      await clearIntervalAsync(interval);
    }
    process.exit(1);
  }
}

main();