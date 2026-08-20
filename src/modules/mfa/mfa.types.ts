export interface ChallengeTarget {
  id: string;
  email: string;
  fullName: string;
}

export interface IssuedChallenge {
  challengeId: string;
  expiresAt: Date;
  /** False when the provider rejected the send; the code exists but never arrived. */
  emailDelivered: boolean;
}

export interface TrustedDeviceGrant {
  deviceToken: string;
  expiresAt: Date;
}

export interface PublicTrustedDevice {
  id: string;
  label: string;
  lastSeenAt: Date;
  expiresAt: Date;
  createdAt: Date;
  ip: string | null;
}
