export const CUSTOMER_MEMORY_MODULE = {
  name: "customerMemory",
  enabledBy: "ENABLE_CUSTOMER_MEMORY",
  status: "minimal",
  storagePolicy: "Store compact, sanitized summaries only. Do not store secrets or unnecessary sensitive data."
};

export function buildCustomerMemoryReadModel(memory) {
  return {
    enabled: false,
    summary: memory && memory.known_business_terms ? memory.known_business_terms.join(", ") : "",
    source: "optional_customer_memory"
  };
}
