# Strive v2 API

### Getting Started

Install dependencies:

```bash
yarn install
```

Run the development server:

```bash
yarn dev
```

## Environment Variables

Create a `.env` file in the root directory with the following variables.

For local development, you can optionally create a `.env.local` file to override values from `.env`.

### Required Variables

- `ENVIRONMENT`: Environment type (development, test, production)
- `MONGO_URI`: MongoDB connection string
- `OPENAI_API_KEY`: OpenAI API key for course generation
- `ANTHROPIC_API_KEY`: Anthropic API key for course generation
- `JWT_SECRET`: JWT secret for authentication
- `FRONTEND_URL`: Frontend URL for CORS
- `GOOGLE_CLIENT_ID`: Google Client ID for OAuth
- `MAILJET_API_KEY`: Mailjet API key for email sending
- `MAILJET_API_SECRET`: Mailjet API secret for email sending
- `AWS_S3_BUCKET`: AWS S3 bucket name
- `AWS_S3_REGION`: AWS S3 region
- `AWS_ACCESS_KEY_ID`: AWS Access Key ID
- `AWS_SECRET_ACCESS_KEY`: AWS Secret Access Key

### Optional Variables

- `PORT`: Server port (defaults to 4000)
- `API_URL`: API base URL (defaults to `http://localhost:${PORT}`)
