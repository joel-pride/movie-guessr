// Mock data for development/testing without a TMDB key or network access.
// Enable with MOCK=1 in the environment or .env.

export const MOCK_FILMS = [
  { title: 'The Matrix', year: 1999, slug: 'the-matrix' },
  { title: 'Inception', year: 2010, slug: 'inception' },
  { title: 'Parasite', year: 2019, slug: 'parasite' },
  { title: 'Mad Max: Fury Road', year: 2015, slug: 'mad-max-fury-road' },
  { title: 'Spirited Away', year: 2001, slug: 'spirited-away' },
  { title: 'There Will Be Blood', year: 2007, slug: 'there-will-be-blood' },
  { title: 'La La Land', year: 2016, slug: 'la-la-land' },
  { title: 'Whiplash', year: 2014, slug: 'whiplash' },
  { title: 'Blade Runner 2049', year: 2017, slug: 'blade-runner-2049' },
  { title: 'The Grand Budapest Hotel', year: 2014, slug: 'the-grand-budapest-hotel' },
  { title: 'Get Out', year: 2017, slug: 'get-out' },
  { title: 'Her', year: 2013, slug: 'her' },
  { title: 'Arrival', year: 2016, slug: 'arrival' },
  { title: 'Children of Men', year: 2006, slug: 'children-of-men' },
  { title: 'Perfect Blue', year: 1997, slug: 'perfect-blue' },
  { title: 'Heat', year: 1995, slug: 'heat' },
  { title: 'Aliens', year: 1986, slug: 'aliens' },
  { title: 'No Country for Old Men', year: 2007, slug: 'no-country-for-old-men' },
];

export function mockResolveFilm(film) {
  const seed = film.slug || film.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `mock-${seed}`,
    slug: film.slug || null,
    title: film.title,
    year: film.year,
    stills: Array.from({ length: 5 }, (_, i) =>
      `https://picsum.photos/seed/${seed}-still-${i}/1280/720`),
    posterUrl: `https://picsum.photos/seed/${seed}-poster/400/600`,
  };
}
