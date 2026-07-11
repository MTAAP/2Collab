export interface LocalSecretStore {
  getOrCreate(name: string): Uint8Array;
}

export interface OwnerReauthenticationPort {
  verify(ownerMemberId: string, proof: string): Promise<boolean>;
}
