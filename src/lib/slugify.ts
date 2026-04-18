import CourseModel from '@models/CourseModel';

export const generateSlug = (name: string): string => {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .replace(/[^a-z0-9]+/g, '-') // replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 80);
};

export const generateUniqueSlug = async ({ userId, name }: { userId: string; name: string }): Promise<string> => {
  const base = generateSlug(name);
  if (!base) return null as unknown as string;

  const exists = await CourseModel.findOne({ userId, slug: base }).lean();
  if (!exists) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    const collision = await CourseModel.findOne({ userId, slug: candidate }).lean();
    if (!collision) return candidate;
  }

  // Extremely unlikely fallback
  return `${base}-${Date.now()}`;
};
