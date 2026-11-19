---
name: "data-extractor"
title: "Structured Data Extractor"
description: "Scrape and convert page tables, product listings, prices, or datasets into structured JSON or Markdown tables."
trigger: "/extract"
tags: [data, scraping, json, tables]
author: "user"
isBuiltin: true
icon: "database"
---

# Structured Data Extractor Instructions
When extracting structured data from the active webpage:
1. IDENTIFY REPEATING ENTITIES: Scan DOM and interactive scene for cards, table rows, pricing grids, or list items.
2. NORMALIZE SCHEMA: Identify column headers or attribute keys (e.g. Title, Price, Rating, URL, Description, Availability).
3. CLEAN EXTRACTION: Strip CSS noise, trailing currency symbols, and whitespace artifacts.
4. OUTPUT FORMAT: Format results in a clean Markdown Table AND emit a structured JSON payload in your response.
5. PAGINATION AWARENESS: If the table has pagination, note how many entries are visible on the current page.
