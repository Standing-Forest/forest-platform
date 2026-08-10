/**
 * Sample data for the parts of the platform that have no approved contract.
 *
 * Nothing here is stored or sent anywhere. It exists so the organization can
 * see what the product would feel like, and so the shape of these records can
 * be argued about before anyone writes the real schemas. Every screen that
 * reads from this file is badged "Demo".
 */

export const farmers = [
  {
    id: "F-1042",
    name: "Ana Ribeiro",
    community: "São Gabriel",
    hectares: 42,
    status: "Enrolled",
    enrolledOn: "2026-05-14",
    parcels: 3,
    trees: 1840,
  },
  {
    id: "F-1043",
    name: "Marcos Tavares",
    community: "Novo Airão",
    hectares: 18,
    status: "Enrolled",
    enrolledOn: "2026-06-02",
    parcels: 1,
    trees: 610,
  },
  {
    id: "F-1051",
    name: "Beatriz Nunes",
    community: "Presidente Figueiredo",
    hectares: 76,
    status: "Awaiting verification",
    enrolledOn: "2026-07-19",
    parcels: 4,
    trees: 0,
  },
  {
    id: "F-1052",
    name: "Joaquim Serra",
    community: "São Gabriel",
    hectares: 9,
    status: "Contacted",
    enrolledOn: "2026-07-28",
    parcels: 0,
    trees: 0,
  },
];

export const pipeline = [
  { stage: "Contacted", count: 46 },
  { stage: "Visit scheduled", count: 23 },
  { stage: "Awaiting verification", count: 11 },
  { stage: "Enrolled", count: 317 },
];

export const fieldActivity = [
  { when: "2 hours ago", who: "R. Alvarenga", what: "Recorded 12 trees at Parcel P-2291", synced: true },
  { when: "5 hours ago", who: "L. Moreira", what: "Enrolled farmer Joaquim Serra", synced: true },
  { when: "yesterday", who: "R. Alvarenga", what: "Boundary walk, Parcel P-2288", synced: false },
  { when: "yesterday", who: "C. Batista", what: "Photographed 3 evidence points", synced: false },
];

export const donations = [
  { when: "2026-07-30", donor: "Anonymous", amount: 500, designation: "Amazonas basin" },
  { when: "2026-07-28", donor: "Helena Whitcombe", amount: 75, designation: "Where needed most" },
  { when: "2026-07-27", donor: "Cedarline Foundation", amount: 25000, designation: "Farmer payments" },
  { when: "2026-07-25", donor: "Anonymous", amount: 200, designation: "Tree registration" },
];

export const showcaseProjects = [
  {
    name: "Rio Negro Headwaters",
    region: "Amazonas",
    hectares: 4200,
    farmers: 96,
    blurb: "Primary lowland forest along the Rio Negro, protected in partnership with 96 smallholders.",
  },
  {
    name: "Presidente Figueiredo Corridor",
    region: "Amazonas",
    hectares: 3180,
    farmers: 71,
    blurb: "A wildlife corridor linking two reserves, keeping fragmented parcels connected.",
  },
  {
    name: "Novo Airão Riverbank",
    region: "Amazonas",
    hectares: 5100,
    farmers: 150,
    blurb: "Riverbank forest that shields spawning grounds and prevents erosion in the wet season.",
  },
];
