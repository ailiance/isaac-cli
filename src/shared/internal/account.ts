/**
 * List of email domains that are considered trusted testers for Isaac.
 */
const DIRAC_TRUSTED_TESTER_DOMAINS = ["fibilabs.tech"]

/**
 * Checks if the given email belongs to a Isaac bot user.
 * E.g. Emails ending with @dirac.run
 */
export function isIsaacBotUser(email: string): boolean {
	return email.endsWith("@dirac.run")
}

export function isIsaacInternalTester(email: string): boolean {
	return isIsaacBotUser(email) || DIRAC_TRUSTED_TESTER_DOMAINS.some((d) => email.endsWith(`@${d}`))
}
