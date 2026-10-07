// Next.js loads .env.local by itself. Scripts and the worker import this first.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
