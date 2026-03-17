# Toppa API Reference

Base URL: `https://api.toppa.cc`

## Payment Model (x402)

Paid endpoints require cUSD payment on Celo via the x402 protocol.

**Fee formula:** `product_amount + (product_amount * 1.5%)` — simple flat 1.5% fee.

| Example | Product | Fee (1.5%) | Total |
|---------|---------|------------|-------|
| $5 airtime | $5.00 | $0.08 | **$5.08 cUSD** |
| $25 gift card | $25.00 | $0.38 | **$25.38 cUSD** |
| $100 bill | $100.00 | $1.50 | **$101.50 cUSD** |
| $500 bill | $500.00 | $7.50 | **$507.50 cUSD** |

**How to pay:**
1. Call a paid endpoint without the `X-PAYMENT` header
2. Get back a `402` response with the exact total and wallet address
3. Send cUSD to the `payTo` address on Celo
4. Call again with `X-PAYMENT: 0xYOUR_TX_HASH` header

---

## Public Endpoints (Free)

### `GET /`

Agent info, protocols, services, and fee examples.

**Response:**
```json
{
  "agent": "Toppa",
  "version": "2.0.0",
  "description": "AI agent for digital goods and utility payments across 170+ countries on Celo",
  "chain": "Celo",
  "protocols": {
    "x402": {
      "fee": "1.5% of product amount",
      "feeFormula": "product_amount * 1.015 (product + 1.5% fee)",
      "asset": "0x765DE816845861e75A25fCA122bb6898B8B1282a",
      "payTo": "0x558e7BFaF2Cf1A494F44E50D92431Afc060c9D12"
    }
  },
  "services": ["airtime", "data_plans", "bills", "gift_cards"]
}
```

---

### `GET /countries`

List all 159 supported countries.

**Response:**
```json
{
  "total": 159,
  "countries": [
    {
      "code": "NG",
      "name": "Nigeria",
      "currency": "NGN",
      "callingCodes": ["+234"],
      "flag": "🇳🇬"
    }
  ]
}
```

---

### `GET /countries/:code/services`

Check what services are available in a specific country.

**Example:** `GET /countries/NG/services`

**Response:**
```json
{
  "countryCode": "NG",
  "airtime": {
    "available": true,
    "operators": [
      { "id": 341, "name": "MTN Nigeria" },
      { "id": 342, "name": "Globacom Nigeria" }
    ]
  },
  "dataPlans": {
    "available": true,
    "operators": [
      { "id": 646, "name": "MTN Nigeria Data" }
    ]
  },
  "bills": {
    "available": true,
    "total": 35,
    "types": {
      "ELECTRICITY_BILL_PAYMENT": 11,
      "TV_BILL_PAYMENT": 8
    }
  },
  "giftCards": {
    "available": true,
    "totalProducts": 19,
    "brands": ["Amazon", "Steam", "Netflix"]
  }
}
```

---

### `GET /operators/:country`

List mobile operators for airtime top-ups.

**Example:** `GET /operators/NG`

**Response:**
```json
{
  "country": "NG",
  "operators": [
    {
      "operatorId": 341,
      "name": "MTN Nigeria",
      "data": false,
      "bundle": false,
      "denominationType": "RANGE",
      "minAmount": 0.04,
      "maxAmount": 138.98,
      "senderCurrencyCode": "USD",
      "destinationCurrencyCode": "NGN"
    }
  ],
  "total": 14
}
```

---

### `GET /data-plans/:country`

List data plan operators with bundle details.

**Example:** `GET /data-plans/NG`

**Response:**
```json
{
  "country": "NG",
  "operators": [
    {
      "operatorId": 646,
      "name": "MTN Nigeria Data",
      "isData": true,
      "isBundle": true,
      "denominationType": "FIXED",
      "fixedAmounts": [1.24, 2.48, 4.96],
      "fixedAmountsDescriptions": {
        "1.24": "5GB Weekly Plan",
        "2.48": "10GB Monthly Plan"
      },
      "minAmount": 0.62,
      "maxAmount": 12.39,
      "senderCurrency": "USD",
      "localCurrency": "NGN"
    }
  ],
  "total": 3
}
```

---

### `GET /billers/:country`

List utility billers. Supports `?type=` filter.

**Types:** `ELECTRICITY_BILL_PAYMENT`, `WATER_BILL_PAYMENT`, `TV_BILL_PAYMENT`, `INTERNET_BILL_PAYMENT`

**Example:** `GET /billers/NG?type=ELECTRICITY_BILL_PAYMENT`

**Response:**
```json
{
  "country": "NG",
  "billers": [
    {
      "id": 5,
      "name": "Ikeja Electric Payment - IKEDC",
      "type": "ELECTRICITY_BILL_PAYMENT",
      "serviceType": "PREPAID",
      "localTransactionCurrencyCode": "NGN",
      "minLocalTransactionAmount": 500,
      "maxLocalTransactionAmount": 500000
    }
  ],
  "total": 11
}
```

---

### `GET /gift-cards/search?q=Steam`

Search gift cards by brand name. Optional `&country=US` filter.

**Example:** `GET /gift-cards/search?q=Steam&country=US`

**Response:**
```json
{
  "query": "Steam",
  "results": [
    {
      "productId": 4,
      "name": "Steam USD",
      "brand": "Steam",
      "country": "United States",
      "currency": "USD",
      "denominationType": "FIXED",
      "fixedDenominations": [5, 10, 20, 50, 100],
      "minAmount": 5,
      "maxAmount": 100
    }
  ],
  "total": 3
}
```

---

### `GET /gift-cards/:country`

List all gift card brands available in a country.

**Example:** `GET /gift-cards/US`

**Response:**
```json
{
  "country": "US",
  "totalProducts": 84,
  "brands": [
    {
      "brandName": "Amazon",
      "products": 3,
      "minPrice": 1,
      "maxPrice": 200,
      "currency": "USD"
    },
    {
      "brandName": "Steam",
      "products": 1,
      "minPrice": 5,
      "maxPrice": 100,
      "currency": "USD"
    }
  ]
}
```

---

### `GET /promotions/:country`

Get active operator promotions and bonus deals.

**Example:** `GET /promotions/NG`

**Response:**
```json
{
  "country": "NG",
  "promotions": [
    {
      "id": 123,
      "operatorId": 341,
      "title": "Buy 1GB get 2GB bonus",
      "description": "Double data on all MTN plans this week",
      "startDate": "2026-03-01",
      "endDate": "2026-03-31"
    }
  ],
  "total": 5
}
```

---

### `GET /transaction/:type/:id`

Check transaction status. Type: `airtime`, `data`, or `bill`.

**Example:** `GET /transaction/airtime/12345`

**Response:**
```json
{
  "transactionId": 12345,
  "type": "airtime",
  "status": "SUCCESSFUL",
  "operatorName": "MTN Nigeria",
  "amount": 5,
  "currency": "USD",
  "date": "2026-03-14T10:30:00Z"
}
```

---

### `GET /gift-card-code/:transactionId`

Retrieve redeem codes for a purchased gift card. Free — already paid at purchase.

**Example:** `GET /gift-card-code/67890`

**Response:**
```json
{
  "transactionId": 67890,
  "codes": [
    {
      "cardNumber": "XXXX-XXXX-XXXX-1234",
      "pinCode": "5678",
      "expiryDate": "2027-12-31"
    }
  ]
}
```

---

### `GET /identity`

Agent ERC-8004 on-chain identity and registration file.

**Response:**
```json
{
  "agent": "Toppa",
  "onChain": {
    "agentId": "1",
    "owner": "0x558e...",
    "uri": "data:application/json;base64,...",
    "wallet": "0x558e...",
    "chain": "Celo"
  },
  "registrationFile": {
    "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    "name": "Toppa",
    "description": "AI agent for digital goods...",
    "image": "https://api.toppa.cc/agent-image.svg",
    "x402Support": true,
    "active": true,
    "supportedTrust": ["reputation"]
  }
}
```

---

### `GET /reputation`

Agent reputation score from ERC-8004 Reputation Registry.

**Response:**
```json
{
  "agent": "Toppa",
  "agentId": "1",
  "score": 98.5,
  "totalFeedback": 142,
  "clients": 37,
  "chain": "Celo"
}
```

---

### `POST /api/verify`

Self Protocol ZK verification callback. Called by Self's relayer after user verifies in the Self app.

**Request body:** ZK proof payload from Self Protocol.

---

## Paid Endpoints (x402)

All paid endpoints follow the same pattern:
1. Call without `X-PAYMENT` header → get `402` with exact amount
2. Send cUSD on Celo to the agent wallet
3. Call again with `X-PAYMENT: 0xTX_HASH` header

---

### `POST /send-airtime`

Send mobile airtime top-up.

**Request:**
```json
{
  "phone": "08147658721",
  "countryCode": "NG",
  "amount": 5,
  "useLocalAmount": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| phone | string | yes | Recipient phone number |
| countryCode | string | yes | Country ISO code (NG, KE, GH, etc.) |
| amount | number | yes | Amount in USD (or local currency if useLocalAmount=true) |
| operatorId | number | no | Operator ID from `/operators/:country`. Auto-detected if omitted. |
| useLocalAmount | boolean | no | If true, amount is in local currency. Default: false (USD). |

**402 Response** (no payment):
```json
{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "celo",
    "maxAmountRequired": "5080000000000000000",
    "payTo": "0x558e7BFaF2Cf1A494F44E50D92431Afc060c9D12",
    "asset": "0x765DE816845861e75A25fCA122bb6898B8B1282a",
    "extra": {
      "name": "cUSD",
      "humanReadableAmount": "5.08",
      "breakdown": { "productAmount": 5, "serviceFee": 0.08, "total": 5.08 }
    }
  }],
  "error": "Payment required: 5.08 cUSD (product: 5, fee: 0.08)..."
}
```

**200 Response** (with payment):
```json
{
  "success": true,
  "transactionId": 12345,
  "operator": "MTN Nigeria",
  "requestedAmount": 5,
  "requestedCurrency": "USD",
  "deliveredAmount": 6030,
  "deliveredCurrency": "NGN",
  "phone": "08147658721",
  "status": "SUCCESSFUL",
  "x402": {
    "totalPaid": "5.08",
    "breakdown": { "total": 5.08, "productAmount": 5, "serviceFee": 0.08 },
    "paymentTx": "0xabc..."
  }
}
```

---

### `POST /send-data`

Send mobile data bundle.

**Request:**
```json
{
  "phone": "08147658721",
  "countryCode": "NG",
  "amount": 1.24,
  "operatorId": 646,
  "useLocalAmount": false
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| phone | string | yes | Recipient phone number |
| countryCode | string | yes | Country ISO code |
| amount | number | yes | Amount — must match a fixed denomination from `/data-plans/:country` |
| operatorId | number | yes | Data operator ID from `/data-plans/:country` |
| useLocalAmount | boolean | no | Default: false (USD) |

**200 Response:** Same structure as `/send-airtime`.

---

### `POST /pay-bill`

Pay a utility bill (electricity, water, TV, internet).

**Request:**
```json
{
  "billerId": 5,
  "accountNumber": "4223568280",
  "amount": 1000,
  "useLocalAmount": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| billerId | number | yes | Biller ID from `/billers/:country` |
| accountNumber | string | yes | Meter number, smartcard number, or account number |
| amount | number | yes | Amount to pay |
| useLocalAmount | boolean | no | Default: true (local currency). Set false for USD. |

**200 Response:**
```json
{
  "success": true,
  "transactionId": 456,
  "status": "PROCESSING",
  "referenceId": "REF-789",
  "message": "Bill payment submitted",
  "x402": {
    "totalPaid": "1015",
    "breakdown": { "total": 1015, "productAmount": 1000, "serviceFee": 15 },
    "paymentTx": "0xdef..."
  }
}
```

---

### `POST /buy-gift-card`

Buy a gift card. Redeem codes are auto-included if available.

**Request:**
```json
{
  "productId": 4,
  "amount": 25,
  "recipientEmail": "user@example.com",
  "quantity": 1
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| productId | number | yes | Product ID from `/gift-cards/search` or `/gift-cards/:country` |
| amount | number | yes | Denomination amount (must match available denominations) |
| recipientEmail | string | yes | Email to deliver the gift card to |
| quantity | number | no | Number of cards. Default: 1 |

**200 Response:**
```json
{
  "success": true,
  "transactionId": 67890,
  "amount": 25,
  "currency": "USD",
  "brand": "Steam",
  "product": "Steam USD",
  "status": "SUCCESSFUL",
  "redeemCodes": [
    {
      "cardNumber": "XXXX-XXXX-XXXX-1234",
      "pinCode": "5678"
    }
  ],
  "x402": {
    "totalPaid": "25.38",
    "breakdown": { "total": 25.38, "productAmount": 25, "serviceFee": 0.38 },
    "paymentTx": "0x123..."
  }
}
```

If codes aren't ready yet:
```json
{
  "success": true,
  "transactionId": 67890,
  "redeemCodes": null,
  "redeemCodesNote": "Codes not ready yet. Retry with GET /gift-card-code/67890"
}
```

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "Description of what went wrong",
  "code": "ERROR_CODE"
}
```

The `code` field is included when the error originates from Reloadly (airtime, bills, gift cards). Common codes:

**Airtime:** `COUNTRY_NOT_SUPPORTED`, `INVALID_AMOUNT_FOR_OPERATOR`, `INVALID_RECIPIENT_PHONE`, `INSUFFICIENT_BALANCE`, `COULD_NOT_AUTO_DETECT_OPERATOR`, `OPERATOR_UNAVAILABLE_OR_CURRENTLY_INACTIVE`

**Gift Cards:** `PRODUCT_NOT_FOUND`, `PRICE_IS_NOT_PERMITTED`, `TEMPORARY_OUT_OF_STOCK`, `WRONG_PRODUCT_PRICE`, `INSUFFICIENT_BALANCE`

**Utility Bills:** `INVALID_AMOUNT_FOR_OPERATOR`, `AMOUNT_MORE_THAN_MAXIMUM_ALLOWED`, `AMOUNT_LESS_THAN_MINIMUM_ALLOWED`, `INVALID_ACCOUNT`, `BILLER_NOT_FOUND`, `BILLER_NOT_SUPPORTED`, `MISSING_REQUIRED_ADDITIONAL_INFO`

**HTTP Status Codes:**
| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing fields, invalid params) |
| 402 | Payment required (x402) |
| 500 | Server error |
