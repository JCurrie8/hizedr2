import {
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  S3Client,
} from "@aws-sdk/client-s3";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const client = new S3Client({
  region: "auto",
  endpoint: requiredEnv("R2_ENDPOINT"),
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
  },
});
const bucket = requiredEnv("R2_BUCKET");
const desiredRules = [
  {
    AllowedOrigins: [
      "https://hized-platform.vercel.app",
      "https://hized.app",
      "https://*.hized.app",
      "http://localhost:3000",
      "http://localhost:3001",
    ],
    AllowedMethods: ["PUT"],
    AllowedHeaders: ["content-type", "x-amz-meta-*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  },
];

function normalizeRules(rules) {
  return rules.map((rule) => ({
    AllowedOrigins: [...(rule.AllowedOrigins ?? [])].sort(),
    AllowedMethods: [...(rule.AllowedMethods ?? [])].sort(),
    AllowedHeaders: [...(rule.AllowedHeaders ?? [])].map((header) => header.toLowerCase()).sort(),
    ExposeHeaders: [...(rule.ExposeHeaders ?? [])].map((header) => header.toLowerCase()).sort(),
    MaxAgeSeconds: rule.MaxAgeSeconds ?? null,
  }));
}

let previousRules = [];
try {
  const current = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  previousRules = current.CORSRules ?? [];
} catch (error) {
  if (error?.$metadata?.httpStatusCode !== 404) throw error;
}

const updated = JSON.stringify(normalizeRules(previousRules)) !== JSON.stringify(normalizeRules(desiredRules));
if (updated) {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: desiredRules },
    }),
  );
}

console.log(
  JSON.stringify({
    updated,
    origins: desiredRules[0].AllowedOrigins,
    methods: desiredRules[0].AllowedMethods,
    headers: desiredRules[0].AllowedHeaders,
  }),
);
