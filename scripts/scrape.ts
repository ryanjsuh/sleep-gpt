import { PGChunk, PGEssay, PGJSON } from "@/types";
import axios from "axios";
import * as cheerio from 'cheerio'; 
import { CheerioAPI } from 'cheerio';
import fs from "fs";
import { encode } from "gpt-3-encoder";
import { chromium } from 'playwright';

const BASE_URL = "https://www.ncbi.nlm.nih.gov/pmc/?term=sleep+deprivation";
const MAX_PAGES = 200; // Set the maximum number of pages to scrape for PubMed query
const CHUNK_SIZE = 200; 
const AXIOS_TIMEOUT = 30000; // 30 seconds
const RETRY_COUNT = 3;
const RETRY_DELAY = 1000; // 1 second

axios.defaults.timeout = AXIOS_TIMEOUT;
axios.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3';

// Retry logic for Axios requests
const axiosRetry = async (url: string, retries: number = RETRY_COUNT, delay: number = RETRY_DELAY) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios.get(url);
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// Sleep function for rate limiting
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


const getLinks = async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const linksArr: { url: string; title: string; authors: string }[] = [];

  try {
    await page.goto(BASE_URL);

    for (let currentPage = 1; currentPage <= MAX_PAGES; currentPage++) {
      const rprtDivs = await page.$$("div.rprt");

      for (const rprtDiv of rprtDivs) {
        const link = await rprtDiv.$(".title a.view");
        const url = link ? await link.getAttribute('href') : null;
        const title = link ? await link.textContent() : null;

        const authorDesc = await rprtDiv.$('.desc');
        const authorText = authorDesc ? await authorDesc.textContent() : null;

        if (url && url.endsWith("/") && title && authorText !== null) {
          const authorNames = authorText.split(',').map(author => author.trim());
          const authorString = authorNames.join(', ');

          const linkObj = {
            url: `https://www.ncbi.nlm.nih.gov${url}`,
            title,
            authors: authorString
          };

          linksArr.push(linkObj);
        }
      }

      if (currentPage < MAX_PAGES) {
        const nextButton = await page.$('a.active.page_link.next:not([disabled])');
        if (!nextButton) {
          console.log(`No 'next' button found. Exiting at page ${currentPage}`);
          break; // Exit the loop if there's no next button
        }

        await Promise.all([
          nextButton.click(), // Click the "next" button to go to the next page
          page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }).catch(e => console.log('Navigation timeout reached', e)) // Wait for navigation to complete
        ]);
      }
    }
  } catch (error) {
    console.error("Error fetching page:", error);
  } finally {
    await browser.close();
  }

  return linksArr;
};

const getContentFromSelector = ($: CheerioAPI, selector: string): string => {
  let content = "";
  $(selector).each((_, element) => {
    content += $(element).text().trim();
  });
  return content;
};

const getEssay = async (url: string, title: string, authors: string) => {
  let essay: PGEssay = {
    title,
    url,
    date: "",
    authors,
    content: "",
    tokens: 0,
    chunks: []
  }

  try {
    const response = await axiosRetry(url);

    if (!response) {
      console.error("No response received for URL:", url);
      return essay; // Skip the current iteration and proceed to the next one
    }

    const $ = cheerio.load(response.data);

    const dateElement = $("span.fm-vol-iss-date"); 
    const dateStr = dateElement.text().trim();
    const dateMatch = dateStr.match(/\b\d{4} (?:Jan|eb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/);
    const extractedDate = dateMatch ? dateMatch[0] : '';

    const content = getContentFromSelector($, "div.tsec.sec");
    const trimmedContent = content.trim();

    essay = {
      title,
      url,
      date: extractedDate,
      authors,
      content,
      tokens: encode(trimmedContent).length,
      chunks: []
    };
  } catch (error: any) {
    if (error.response) {
      // Log only the status code and the status message
      console.error(`Error fetching essay: ${error.response.status} ${error.response.statusText}`);
      // Optionally, log the URL that caused the error
      console.error(`URL: ${url}`);
    } else {
      // If the error is not a response error (no HTTP status), log the full error
      console.error("Error fetching essay:", error);
    }
    return essay; // Skip this essay on error
  }
return essay;
};

const getChunks = async (essay: PGEssay) => {
  const { title, url, date, authors, content } = essay;

  let essayTextChunks: string[] = [];

  try {
    if (encode(content).length > CHUNK_SIZE) {
      const splitSentences = content.split(". ")
      let chunkText = "";

      for (let i = 0; i < splitSentences.length; i++) {
        const sentence = splitSentences[i];
        if (typeof sentence === 'string') {
          const sentenceTokenLength = encode(sentence).length;
          const chunkTextTokenLength = encode(chunkText).length;

          if (chunkTextTokenLength + sentenceTokenLength > CHUNK_SIZE) {
            essayTextChunks.push(chunkText)
            chunkText = ""
          }

          if (sentence[sentence.length - 1].match(/[a-z0-9]/i)) {
            chunkText += sentence + ". ";
          } else {
            chunkText += sentence + " ";
          }
        } else {
          console.log(`Skipping sentence at index ${i} due to invalid type:`, sentence);
        }
      }
      essayTextChunks.push(chunkText.trim());
    } else {
      essayTextChunks.push(content.trim());
    }

    const essayChunks: PGChunk[] = essayTextChunks.map((chunkText, i) => {
      const chunk: PGChunk = {
        essay_title: title,
        essay_url: url,
        essay_date: date,
        essay_authors: authors,
        content: chunkText,
        content_tokens: encode(chunkText).length,
        embedding: []
      }

      return chunk;
    });

    if (essayChunks.length > 1) {
      for (let i = 0; i < essayChunks.length; i++) {
        const chunk = essayChunks[i];
        const prevChunk = essayChunks[i - 1];

        if (chunk.content_tokens < 100 && prevChunk) {
          prevChunk.content += " " + chunk.content;
          prevChunk.content_tokens += chunk.content_tokens;
          essayChunks.splice(i, 1);
        }
      }
    }
    const chunkEssay: PGEssay = {
      ...essay,
      chunks: essayChunks
    };
    return chunkEssay;
  } catch (error) {
    console.error("Error processing essay chunks:", error);
    return essay; // Return the original essay on error
  }
};

(async () => {
  const links = await getLinks();

  let essays: PGEssay[] = [];

  for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const essay = await getEssay(link.url, link.title, link.authors);
      const chunkEssay = await getChunks(essay);
      essays.push(chunkEssay);
      await sleep(2000); // Delay between processing each link
  }

  const json: PGJSON = {
    tokens: essays.reduce((acc, essay) => acc + essay.tokens, 0),
    essays
  };

  fs.writeFileSync("scripts/pg.json", JSON.stringify(json));
})();
