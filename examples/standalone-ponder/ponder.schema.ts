/**
 * Re-export the EFP plugin's abstract schema unchanged. In a full ENSNode
 * deployment, the abstract schema is composed from multiple sub-schemas in
 * `@ensnode/ensdb-sdk/ensindexer-abstract`; here we only need EFP's tables.
 */
export * from "@efpnode/ensnode-plugin-efp/schema";
