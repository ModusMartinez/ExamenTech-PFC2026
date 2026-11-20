export function photosEnabled() {
  return (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_EXAM_PHOTOS_ENABLED === 'true'
}

export function examManagementEnabled() {
  return (import.meta as ImportMeta & { env?: Record<string, unknown> }).env?.VITE_EXAM_MANAGEMENT_ENABLED === 'true'
}
