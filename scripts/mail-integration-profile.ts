#!/usr/bin/env bun
import {
  loadMailIntegrationProfile,
  validateMailIntegrationProfile,
} from "../src/mail-integration-profile";

function main(): void {
  const profileIndex = Bun.argv.indexOf("--profile");
  const profilePath = profileIndex >= 0 && Bun.argv[profileIndex + 1]
    ? Bun.argv[profileIndex + 1]
    : "docs/mail-integration-profile.json";
  const profile = loadMailIntegrationProfile(profilePath);
  const errors = validateMailIntegrationProfile(profile);
  if (errors.length > 0) {
    for (const error of errors) console.error(`Mail integration profile error: ${error}`);
    process.exit(1);
  }
  console.log(`Mail integration profile OK: ${profile.tenants.length} tenants`);
}

main();
