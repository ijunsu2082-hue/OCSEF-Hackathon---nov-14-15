/*
 * Official email domains for asset owners, used by email_domain verification.
 *
 * Each entry maps owner names exactly as they appear in our public data (EIA-860
 * utility_name for plants, OpenStreetMap operator tag for substations and lines)
 * to the domain of the organization's official website. Each domain was checked
 * by loading the site on Nov 14, 2026 (see `checked`). Matching is by exact
 * normalized name, never by substring, so "SunEdison LLC" does not match Edison.
 *
 * Keep this list small and verified. An owner missing here can still be verified
 * with a document that an admin reviews.
 */

export interface OwnerDomainEntry {
  /** Display name of the organization. */
  owner: string;
  /** Names used for this owner in EIA-860 / OpenStreetMap (matched after normalizeOwnerName). */
  aliases: string[];
  /** Official domains; a work email on the domain or a subdomain of it verifies. */
  domains: string[];
  /** Official page loaded to confirm the domain. */
  checked: string;
}

export const OWNER_DOMAINS: OwnerDomainEntry[] = [
  {
    owner: "Southern California Edison",
    aliases: ["Southern California Edison Co", "Southern California Edison", "SoCal Edison", "So Cal Edison", "SCE"],
    domains: ["sce.com"],
    checked: "https://www.sce.com/ (Welcome to SCE), Nov 14, 2026",
  },
  {
    owner: "San Diego Gas & Electric",
    aliases: [
      "San Diego Gas & Electric Co",
      "San Diego Gas & Electric",
      "San Diego Gas and Electric",
      "SDG&E",
      "San Deigo Gas and Electric", // spelling as tagged in OpenStreetMap
    ],
    domains: ["sdge.com"],
    checked: "https://www.sdge.com/ (SDGE | San Diego Gas & Electric), Nov 14, 2026",
  },
  {
    owner: "Los Angeles Department of Water and Power",
    aliases: [
      "Los Angeles Department of Water & Power",
      "Los Angeles Department of Water and Power",
      "LADWP",
      "Los Angeles Department and Power", // spelling as tagged in OpenStreetMap
    ],
    domains: ["ladwp.com"],
    checked: "https://www.ladwp.com/ (LADWP Home | Los Angeles Department of Water and Power), Nov 14, 2026",
  },
  {
    owner: "Pacific Gas and Electric Company",
    aliases: ["Pacific Gas and Electric Company", "Pacific Gas & Electric Co", "PG&E"],
    domains: ["pge.com"],
    checked: "https://www.pge.com/ (Pacific Gas & Electric Company | PG&E), Nov 14, 2026",
  },
  {
    owner: "Metropolitan Water District of Southern California",
    aliases: ["Metropolitan Water District of S CA", "Metropolitan Water District of Southern California"],
    domains: ["mwdh2o.com"],
    checked: "https://www.mwdh2o.com/ (Metropolitan Water District of Southern California Homepage), Nov 14, 2026",
  },
  {
    owner: "The AES Corporation",
    aliases: [
      "AES",
      "AES Corporation",
      "AES Clean Energy",
      "AES Distributed Energy",
      "AES Alamitos Energy, LLC",
      "AES Alamitos LLC",
      "AES ES Alamitos, LLC",
      "AES Huntington Beach Energy, LLC",
      "AES Huntington Beach LLC",
    ],
    domains: ["aes.com"],
    checked: "https://www.aes.com/ (AES | Accelerating the Future of Global Energy), Nov 14, 2026",
  },
  {
    owner: "Terra-Gen",
    aliases: [
      "Terra-Gen",
      "Terra-Gen Operating Co-Wind",
      "Terra-Gen Operating Co-Solar",
      "Terra-Gen Operating Co-Hybrid",
      "Terra-Gen Operating Co-BESS",
      "Terra-Gen Operating Co-BESS 2",
    ],
    domains: ["terra-gen.com"],
    checked: "https://www.terra-gen.com/ (footer: © Terra-Gen 2023 - 2025), Nov 14, 2026",
  },
  {
    owner: "NextEra Energy Resources",
    aliases: ["Nextera Energy Resources", "NextEra Energy Resources, LLC"],
    // nexteraenergy.com is the parent company's site, linked from nexteraenergyresources.com.
    domains: ["nexteraenergyresources.com", "nexteraenergy.com"],
    checked: "https://www.nexteraenergyresources.com/ (Copyright © 2026 NextEra Energy Resources, LLC), Nov 14, 2026",
  },
];

/**
 * Consumer mailbox providers. An address here never verifies ownership, even if a
 * future entry above were to list one of these by mistake.
 */
export const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com",
  "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "hey.com", "fastmail.com", "att.net",
  "sbcglobal.net", "comcast.net", "verizon.net", "cox.net", "charter.net", "earthlink.net",
]);
