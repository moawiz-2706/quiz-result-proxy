# my-ghl-proxy

A small Vercel Node.js project that exposes a single API route at `/api/result` for the GHL survey result proxy.

## Environment variables

Set these in Vercel Project Settings or locally in a `.env` file:

- `GHL_PRIVATE_INTEGRATION_TOKEN`
- `GHL_LOCATION_ID`
- `DEFAULT_SURVEY_ID` (default: `jKExVfpjspMDMxHHQSJq`)

## Local development

```bash
npm install -g vercel
vercel dev
```

## Deploy

```bash
vercel
```

## Request example

```bash
curl -X POST https://your-project-name.vercel.app/api/result \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","surveyId":"jKExVfpjspMDMxHHQSJq"}'
```
