// demo.js — fake data for DEMO_MODE (never used unless DEMO_MODE=true)
const DEMO_CODE = "DEMO";

const ses = (dayName, start, end, modality) => ({ dayName, start, end, modality });

const profile = {
  dni: "00000000",
  email_institucional: "demo@example.com",
  phone: "999000000",
  facultyName: "Facultad Demo",
  specialtyName: "Ingeniería Demo",
  facultyCode: "DEMO",
  specialtyCode: "DEMO",
  gender: "",
  age: "20",
  mode: "Presencial",
  periodCode: "DEMO",
};

const enrolled = [
  {
    courseCode: "DEM101", courseName: "Matemática Demo", groupCode: "A",
    modality: "Teoría", day: "Lunes", hour: "08:00–10:00", teacherName: "Docente Demo 1", credits: 4,
    sessions: [
      { day: "Lunes", hour: "08:00–10:00", modality: "Teoría", teacherName: "Docente Demo 1" },
      { day: "Miércoles", hour: "08:00–10:00", modality: "Teoría", teacherName: "Docente Demo 1" },
    ],
  },
  {
    courseCode: "DEM102", courseName: "Programación Demo", groupCode: "B",
    modality: "Teoría", day: "Martes", hour: "10:00–12:00", teacherName: "Docente Demo 2", credits: 3,
    sessions: [
      { day: "Martes", hour: "10:00–12:00", modality: "Teoría", teacherName: "Docente Demo 2" },
      { day: "Jueves", hour: "10:00–12:00", modality: "Laboratorio", teacherName: "Docente Demo 2" },
    ],
  },
  {
    courseCode: "DEM103", courseName: "Comunicación Demo", groupCode: "A",
    modality: "Teoría", day: "Viernes", hour: "14:00–16:00", teacherName: "Docente Demo 3", credits: 2,
    sessions: [{ day: "Viernes", hour: "14:00–16:00", modality: "Teoría", teacherName: "Docente Demo 3" }],
  },
];

// Same shape the real API returns, so flattenAvailable() works unchanged.
const coursesMap = {
  DEM101: {
    courseName: "Matemática Demo", courseCycle: 1,
    groups: {
      A: { sessions: [ses("Lunes", "08:00", "10:00", "Teoría"), ses("Miércoles", "08:00", "10:00", "Teoría")] },
      B: { sessions: [ses("Martes", "14:00", "16:00", "Teoría"), ses("Jueves", "14:00", "16:00", "Teoría")] },
      C: { sessions: [ses("Sábado", "08:00", "12:00", "Teoría")] },
    },
  },
  DEM102: {
    courseName: "Programación Demo", courseCycle: 1,
    groups: {
      A: { sessions: [ses("Lunes", "10:00", "12:00", "Teoría"), ses("Miércoles", "10:00", "12:00", "Laboratorio")] },
      B: { sessions: [ses("Martes", "10:00", "12:00", "Teoría"), ses("Jueves", "10:00", "12:00", "Laboratorio")] },
    },
  },
  DEM103: {
    courseName: "Comunicación Demo", courseCycle: 1,
    groups: {
      A: { sessions: [ses("Viernes", "14:00", "16:00", "Teoría")] },
      B: { sessions: [ses("Viernes", "16:00", "18:00", "Teoría")] },
    },
  },
};

// Vacancies per course/group (group B of DEM101 is full, for show).
const vacancies = {
  DEM101: { A: [30, 28], B: [30, 30], C: [30, 12] },
  DEM102: { A: [25, 20], B: [25, 24] },
  DEM103: { A: [40, 35], B: [40, 10] },
};

function vacancyRows(courseCode) {
  const v = vacancies[courseCode] || {};
  return Object.entries(v).map(([courseGroup, [total, enrolledN]]) => ({
    courseGroup, number_enrolled: enrolledN, total_vacations: total,
  }));
}

module.exports = { DEMO_CODE, profile, enrolled, coursesMap, vacancyRows };
