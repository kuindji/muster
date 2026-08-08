import {
  computeSkillSha256,
  deepFreeze,
  renderSkill,
  skillReleaseSelectionKey,
  type SkillSource,
} from "@kuindji/muster-contract";

export interface SkillReleaseRegistration {
  readonly source: SkillSource;
  readonly skillSha256: string;
}

export interface SkillRelease {
  readonly selectionKey: string;
  readonly contractVersion: string;
  readonly jobClassIds: readonly string[];
  readonly skillSha256: string;
  readonly rendered: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Immutable deployment release data selected by accepted contract and the
 * complete enrolled class set. Creation verifies the canonical render bytes
 * before publishing any release.
 */
export class SkillReleaseRegistry {
  private readonly releases: readonly SkillRelease[];

  private constructor(releases: readonly SkillRelease[]) {
    this.releases = deepFreeze([...releases]);
    Object.freeze(this);
  }

  static async create(
    registrations: readonly SkillReleaseRegistration[],
  ): Promise<SkillReleaseRegistry> {
    const releases: SkillRelease[] = [];
    const selectionKeys = new Set<string>();
    const hashes = new Set<string>();

    for (const registration of structuredClone(registrations)) {
      const selectionKey = skillReleaseSelectionKey({
        contractVersion: registration.source.contractVersion,
        jobClassIds: registration.source.jobClassIds,
      });
      if (selectionKeys.has(selectionKey)) {
        throw new RangeError("duplicate or ambiguous skill release selection");
      }
      if (!SHA256_HEX.test(registration.skillSha256)) {
        throw new RangeError("invalid skill release SHA-256");
      }
      const rendered = renderSkill(registration.source);
      const computed = await computeSkillSha256(rendered);
      if (computed !== registration.skillSha256) {
        throw new RangeError("skill release SHA-256 mismatch");
      }
      if (hashes.has(computed)) {
        throw new RangeError("duplicate skill release SHA-256");
      }

      selectionKeys.add(selectionKey);
      hashes.add(computed);
      releases.push(deepFreeze({
        selectionKey,
        contractVersion: registration.source.contractVersion,
        jobClassIds: [...registration.source.jobClassIds].sort(),
        skillSha256: computed,
        rendered,
      }));
    }
    return new SkillReleaseRegistry(releases);
  }

  select(input: {
    readonly contractVersion: string;
    readonly jobClassIds: readonly string[];
  }): SkillRelease | null {
    let selectionKey: string;
    try {
      selectionKey = skillReleaseSelectionKey(input);
    } catch {
      return null;
    }
    const release = this.releases.find(
      (candidate) => candidate.selectionKey === selectionKey,
    );
    return release === undefined ? null : structuredClone(release);
  }

  getBySha256(skillSha256: string): SkillRelease | null {
    const release = this.releases.find(
      (candidate) => candidate.skillSha256 === skillSha256,
    );
    return release === undefined ? null : structuredClone(release);
  }
}
