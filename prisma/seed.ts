import { faker } from "@faker-js/faker";
import { PrismaClient } from "@prisma/client";
import type { CompanyStatus, CommonCompanyType, AccountType } from "../src/lib/types";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

const db = new PrismaClient();

const COMPANY_COUNT = 7000;
const BATCH_SIZE = 500;

const UK_POSTCODE_AREAS = [
  "SW1A", "EC1A", "W1A", "N1", "E1", "SE1", "NW1", "M1", "M2", "B1", "B2",
  "LS1", "LS2", "G1", "G2", "EH1", "EH2", "CF10", "CF24", "BT1", "NE1",
  "L1", "L2", "S1", "S2", "BS1", "BS2", "OX1", "CB1", "RG1", "GU1",
];

// Real Companies House enum values (see src/lib/types.ts) — this dev seed
// mimics the shape of real data, it just isn't real data (source="seed").
const STATUS_WEIGHTS: [CompanyStatus, number][] = [
  ["active", 74],
  ["dissolved", 15],
  ["liquidation", 4],
  ["administration", 3],
  ["receivership", 2],
  ["voluntary-arrangement", 2],
];

const TYPE_WEIGHTS: [CommonCompanyType, number][] = [
  ["ltd", 78],
  ["llp", 8],
  ["plc", 3],
  ["limited-partnership", 5],
  ["private-unlimited", 4],
  ["community-interest-company", 2],
];

const ACCOUNT_TYPE_WEIGHTS: [AccountType, number][] = [
  ["small", 40],
  ["micro-entity", 30],
  ["dormant", 10],
  ["full", 8],
  ["medium", 5],
  ["total-exemption-full", 4],
  ["group", 3],
];

const SIC_CODES = ["62012", "62020", "70229", "68209", "41202", "43210", "47910", "56101", "69201", "82990"];

function weightedPick<T>(weights: [T, number][]): T {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = Math.random() * total;
  for (const [value, weight] of weights) {
    if (roll < weight) return value;
    roll -= weight;
  }
  return weights[0][0];
}

function ukPostcode(): string {
  const area = faker.helpers.arrayElement(UK_POSTCODE_AREAS);
  const inward = `${faker.number.int({ min: 0, max: 9 })}${faker.string.alpha({ length: 2, casing: "upper" })}`;
  return `${area} ${inward}`;
}

function companySuffix(type: CommonCompanyType): string {
  switch (type) {
    case "ltd":
      return faker.helpers.arrayElement(["Ltd", "Limited"]);
    case "plc":
      return "PLC";
    case "llp":
      return "LLP";
    case "community-interest-company":
      return "CIC";
    default:
      return "";
  }
}

function randomPastDate(minYears: number, maxYears: number): Date {
  const years = faker.number.float({ min: minYears, max: maxYears });
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(years * 365.25));
  return d;
}

// Development-only data. Refuses to run against a production database, never
// touches real (non-seed) companies, and never prints or commits credentials:
// generated demo passwords are written to ./.dev-credentials.local (gitignored).
async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") {
    throw new Error("Refusing to seed a production environment (set ALLOW_SEED=1 to override).");
  }

  console.log("Removing previous seed companies (real Companies House data is left untouched)...");
  await db.company.deleteMany({ where: { source: "seed" } });

  console.log("Ensuring development users exist...");
  const demoUsers = [
    { email: "admin@director.ltd", name: "Nick", role: "SUPER_ADMIN" },
    { email: "ops@director.ltd", name: "Priya Shah", role: "ADMIN" },
    { email: "sales@director.ltd", name: "Tom Reid", role: "USER" },
  ];
  const credentialLines: string[] = [];
  const users: Record<string, { id: string; name: string }> = {};
  for (const u of demoUsers) {
    const existing = await db.user.findUnique({ where: { email: u.email } });
    if (existing) {
      users[u.email] = existing;
      continue;
    }
    const password = process.env.SEED_PASSWORD ?? randomBytes(12).toString("base64url") + "!aA1";
    const created = await db.user.create({
      data: { email: u.email, name: u.name, role: u.role, passwordHash: await bcrypt.hash(password, 12) },
    });
    users[u.email] = created;
    credentialLines.push(`${u.email} (${u.role}): ${password}`);
  }
  if (credentialLines.length > 0) {
    fs.appendFileSync(".dev-credentials.local", credentialLines.join("\n") + "\n", { mode: 0o600 });
    console.log("New development user passwords written to .dev-credentials.local (gitignored).");
  }
  const superAdmin = users["admin@director.ltd"];
  const salesUser = users["sales@director.ltd"];

  console.log(`Generating ${COMPANY_COUNT} companies...`);
  let created = 0;
  const companyNumbers = new Set<string>();

  for (let batchStart = 0; batchStart < COMPANY_COUNT; batchStart += BATCH_SIZE) {
    const batch = [];
    const batchLen = Math.min(BATCH_SIZE, COMPANY_COUNT - batchStart);

    for (let i = 0; i < batchLen; i++) {
      const type = weightedPick(TYPE_WEIGHTS);
      const status = weightedPick(STATUS_WEIGHTS);
      const incorporationDate = randomPastDate(1, 30);
      const dissolved = status === "dissolved";
      // dormant is derived from the accounts type, exactly like real
      // ingestion does — never picked as an independent random flag.
      const accountType = weightedPick(ACCOUNT_TYPE_WEIGHTS);
      const dormant = accountType === "dormant";
      const directorCount = faker.number.int({ min: 1, max: 5 });
      const accountsOverdue = faker.number.int({ min: 1, max: 100 }) <= 8;
      const confirmationOverdue = faker.number.int({ min: 1, max: 100 }) <= 7;
      // hasDS01 mirrors company_status_detail === "active-proposal-to-strike-off",
      // only possible while a company is still "active".
      const hasDS01 = status === "active" && faker.number.int({ min: 1, max: 100 }) <= 5;

      let companyNumber = faker.string.numeric(8);
      while (companyNumbers.has(companyNumber)) companyNumber = faker.string.numeric(8);
      companyNumbers.add(companyNumber);

      const suffix = companySuffix(type);
      const name = `${faker.company.name().replace(/,?\s*(LLC|Inc\.?|Group)$/i, "")}${suffix ? " " + suffix : ""}`;

      batch.push({
        companyNumber,
        name,
        status,
        statusDetail: hasDS01 ? "active-proposal-to-strike-off" : null,
        type,
        incorporationDate,
        dissolutionDate: dissolved ? randomPastDate(0, 3) : null,
        dormant,
        accountType,
        sicCodes: faker.helpers.arrayElements(SIC_CODES, { min: 1, max: 2 }).join(","),
        registeredAddress1: faker.location.streetAddress(),
        registeredAddress2: faker.datatype.boolean(0.3) ? faker.location.secondaryAddress() : null,
        registeredCity: faker.location.city(),
        registeredPostcode: ukPostcode(),
        registeredCounty: faker.datatype.boolean(0.6) ? faker.location.county() : null,
        accountsNextDue: status === "active" ? faker.date.soon({ days: 200 }) : null,
        accountsLastMadeUp: faker.date.past({ years: 1 }),
        accountsOverdue,
        confirmationNextDue: status === "active" ? faker.date.soon({ days: 365 }) : null,
        confirmationOverdue,
        hasDS01,
        ds01FiledAt: hasDS01 ? new Date() : null,
        directorCount,
        singleDirector: directorCount === 1,
        source: "seed",
      });
    }

    await db.company.createMany({ data: batch });
    created += batch.length;
    console.log(`  ${created}/${COMPANY_COUNT}`);
  }

  console.log("Generating directors...");
  const companies = await db.company.findMany({ where: { source: "seed" }, select: { id: true, directorCount: true } });
  for (let i = 0; i < companies.length; i += BATCH_SIZE) {
    const slice = companies.slice(i, i + BATCH_SIZE);
    const directorBatch = slice.flatMap((company) =>
      Array.from({ length: company.directorCount }, () => ({
        companyId: company.id,
        name: faker.person.fullName(),
        role: "director",
        appointedOn: randomPastDate(0, 10),
        nationality: faker.helpers.arrayElement(["British", "Irish", "French", "Polish", "Indian"]),
        occupation: faker.person.jobTitle(),
      }))
    );
    await db.director.createMany({ data: directorBatch });
  }

  console.log("Seeding sample CRM activity for demo user...");
  const sampleCompanies = await db.company.findMany({ where: { source: "seed" }, take: 25, orderBy: { createdAt: "asc" } });
  for (const [idx, company] of sampleCompanies.entries()) {
    const followed = idx % 3 !== 0;
    const trashed = idx % 7 === 0;
    const state = await db.userCompanyState.create({
      data: { userId: salesUser.id, companyId: company.id, followed, trashed },
    });
    if (idx % 4 === 0) {
      await db.note.create({
        data: {
          userCompanyStateId: state.id,
          body: "Spoke with the director — interested in a follow-up call next week.",
          authorName: salesUser.name,
        },
      });
    }
    if (idx % 5 === 0) {
      await db.followUp.create({
        data: {
          userCompanyStateId: state.id,
          userId: salesUser.id,
          dueDate: faker.date.soon({ days: 14 }),
          note: "Chase for updated accounts",
        },
      });
    }
  }

  console.log("Seeding a sample saved report...");
  await db.report.deleteMany({ where: { ownerId: salesUser.id, name: "Dormant companies with DS01 filed" } });
  await db.report.create({
    data: {
      ownerId: salesUser.id,
      name: "Dormant companies with DS01 filed",
      description: "Dormant companies that have filed a DS01 strike-off notice.",
      filterJson: JSON.stringify({
        id: "root",
        kind: "group",
        combinator: "AND",
        children: [
          { id: "r1", kind: "rule", field: "dormant", operator: "isTrue", value: true },
          { id: "r2", kind: "rule", field: "hasDS01", operator: "isTrue", value: true },
        ],
      }),
      dailyRefresh: true,
      resultCount: await db.company.count({ where: { source: "seed", dormant: true, hasDS01: true } }),
      lastRunAt: new Date(),
    },
  });

  await db.activityLog.createMany({
    data: [
      { userId: superAdmin.id, action: "login", meta: null },
      { userId: salesUser.id, action: "login", meta: null },
      { userId: salesUser.id, action: "report_created", meta: JSON.stringify({ name: "Dormant companies with DS01 filed" }) },
    ],
  });

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
