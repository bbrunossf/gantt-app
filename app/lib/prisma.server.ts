import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

const adapter = new PrismaPg(
    { connectionString: process.env.DATABASE_URL },
    { schema: "public" }
);
export const prisma = new PrismaClient({ adapter });
