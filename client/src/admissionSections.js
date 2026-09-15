// The college's HND application form — the section/field DATA only, no UI.
//
// WHY THIS IS ITS OWN MODULE, rather than living in StaffHub.jsx beside the admin's
// admission entry form (where it sat until Sep 2026, and where it reads most
// naturally): code-splitting. AdmissionApply.jsx (the public application form) and
// ApplicantPortal.jsx (the applicant portal) both need these two constants, and both
// are on the EAGER path — they render for people with no college account at all, so
// App.jsx imports them statically. While the constants lived inside StaffHub.jsx,
// importing them pulled the entire ~17k-line staff/admin bundle (plus recharts) into
// the entry chunk, and the login screen shipped the whole admin dashboard for the sake
// of two arrays. Splitting the entry point does nothing if an eager module still
// statically imports the thing that was split away — so the DATA moved out here, and
// StaffHub.jsx now imports it back. The form definition keeps exactly one home, which
// is what stops the admin's entry form and the public form drifting apart.
//
// The alternative — duplicating the arrays into the public form — was rejected
// outright: a question added to one copy and not the other silently produces
// applications missing an answer the admin's screen requires.

// The college's HND application form, rebuilt as one long entry form an admin fills in.
// The sections and field order mirror the paper/online form so an admin can copy it
// top-to-bottom. Every field is stored as free text on the Admission model; `type`
// only changes the input widget (a date picker, an email keyboard, a Yes/No dropdown).
// `span: 2` makes a field take the full width of the two-column grid (used for the long
// "if yes, give details" answers). Adding a question here + on the Prisma model is all
// it takes to extend the form — the server copies fields off a fixed whitelist.
const YES_NO = ["Yes", "No"];
// The four intake months, and a rolling range of years (this year − 1 … + 5) for the
// intake-year picker.
const INTAKE_MONTHS = ["January", "April", "June", "September"];
// Fallback for the application form's intake dropdown — the real options come from the
// admin-managed AdmissionIntake list (the "Courses & intakes" manager). Until an admin
// adds their own, offer the four standard months across the current and next year.
const INTAKE_FALLBACK = (() => { const y = new Date().getFullYear(); return [y, y + 1].flatMap((yr) => INTAKE_MONTHS.map((m) => `${m} ${yr}`)); })();
// Transcribed verbatim from the college's "EdTech HND Application Form"
// (Microsoft Forms, 61 questions across 9 pages). Question text, option lists, required
// flags and the page/section help notes match the original one-for-one so an admin can
// copy a paper/online application straight down the screen. Fields expecting "N/A" as an
// answer stay as text (a date picker can't hold "N/A"). The "course" field's options are
// replaced at render time with the live courses table (fallback below if it can't load).
export const ADMISSION_SECTIONS = [
  { title: "Course Details", fields: [
    { key: "course", label: "Which course are you applying for", type: "select", required: true, options: ["HND - Business", "HND - Sustainable Business Management", "HND - Leadership and Management"] },
    { key: "intake", label: "Which intake are you applying for?", type: "select", required: true, options: INTAKE_FALLBACK },
    { key: "foundVia", label: "How did you find out about EdTech?", type: "select", required: true, options: ["College Website/Social Media", "Agent", "Family Member", "Friend", "Other"] },
    { key: "classOption", label: "Select the class option you would prefer:", type: "select", hint: "You are required to complete 12hrs of onsite study.", options: ["Two days per week - 10 a.m.-5 p.m (12hrs)", "Two evenings online - 6 p.m.-9 p.m. (6hrs) plus One day In-Campus 10 a.m. - 5 p.m. (6hrs)"] },
    { key: "firstName", label: "First Name", type: "text", required: true },
    { key: "middleName", label: "Middle Name (if any)", type: "text" },
    { key: "surname", label: "Surname", type: "text", required: true },
    { key: "dob", label: "Date of Birth", type: "date", required: true },
    { key: "gender", label: "Gender", type: "select", required: true, options: ["Woman", "Man", "Non-binary", "Prefer not to say"] },
    { key: "email", label: "Email Address", type: "email", required: true },
    { key: "phone", label: "Primary telephone/Mobile Phone", type: "tel", required: true },
    { key: "countryOfBirth", label: "Country of Birth", type: "text", required: true },
    { key: "countryOfCitizenship", label: "Country of citizenship", type: "text", required: true },
    { key: "idDocNo", label: "ID Document (Passport/ID/Driving Licence Etc.) No.", type: "text", required: true },
    { key: "idDateOfIssue", label: "Date of Issue", type: "date", required: true },
    { key: "idDateOfExpiry", label: "Date of Expiry", type: "date", required: true },
    { key: "idIssuingCountry", label: "ID issuing country", type: "text", required: true },
    { key: "niNumber", label: "National Insurance Number (NI Number) (if not held, explain the reason)", type: "text", required: true, span: 2 },
  ] },
  { title: "Home Address", fields: [
    { key: "houseNo", label: "House/Flat No", type: "text", required: true },
    { key: "street", label: "Street", type: "text", required: true },
    { key: "city", label: "City", type: "text", required: true },
    { key: "postCode", label: "Post Code", type: "text", required: true },
    { key: "mailingAddress", label: "Mailing Address (if different from Home address)", type: "textarea", span: 2 },
    { key: "emergencyName", label: "Emergency Contact Name", type: "text", required: true },
    { key: "emergencyPhone", label: "Emergency Contact Phone/Mobile Number", type: "tel", required: true },
    { key: "emergencyRelationship", label: "Emergency Contact Relationship", type: "text", required: true },
    { key: "emergencyEmail", label: "Emergency Contact Email Address", type: "email", required: true },
  ] },
  { title: "Declaration of a criminal record rehabilitation of offender's acts.",
    note: "You are required to state whether you have any criminal convictions, excluding spent sentences (as defined by the Rehabilitation of Offenders Act 1974).",
    fields: [
    { key: "criminalConviction", label: "Have you ever had a criminal conviction?", type: "select", required: true, options: YES_NO },
    { key: "criminalDetails", label: "If yes, please provide further details, including date(s), nature of conviction and punishment imposed. If no, then please write N/A.", type: "textarea", required: true, span: 2 },
  ] },
  { title: "Disabilities",
    note: "The information you provide will be kept confidential and used to support our equal opportunities monitoring, routine academic and administration processes. It may be shared with statutory bodies such as the Higher Education Statistics Agency and the Office for Students in line with data protection laws. EdTech is committed to ensuring that every student is as comfortable as possible during their time with us.",
    fields: [
    { key: "medicalConditions", label: "Do you have any medical conditions that may require special adjustments or arrangements?", type: "select", required: true, options: YES_NO },
    { key: "medicalDetails", label: "If yes, please describe your condition(s) and adjustments/arrangements that EdTech would need to make to support your studies. If no, please write N/A.", type: "textarea", required: true, span: 2 },
    { key: "learningDifficulty", label: "Do you have any learning difficulty?", type: "select", required: true, options: YES_NO },
    { key: "learningDetails", label: "If yes, give details of learning difficulty? (If NO, enter N/A).", type: "textarea", required: true, span: 2 },
  ] },
  { title: "Education and Employment", fields: [
    { key: "englishFirstLanguage", label: "Is English your first language?", type: "select", required: true, options: YES_NO },
    { key: "englishProof", label: "If no, how will you provide proof of your English language proficiency?", type: "select", required: true, options: ["IELTS", "B2 level English or Equivalent", "Functional Skills or level 2", "Other"] },
    { key: "englishProofOther", label: "If you have selected others please specify, otherwise enter N/A.", type: "text", required: true, span: 2 },
    { key: "highestEducation", label: "What is the Highest level of education that you have completed?", type: "select", required: true, options: ["Level 3", "Level 2", "High School", "GCSE/ A levels", "Other"] },
    { key: "overseasQualification", label: "If overseas, please provide details of the qualification; otherwise, write N/A.", type: "textarea", required: true, span: 2 },
    { key: "appliedElsewhere", label: "Have you applied for HND business in any other College/University?", type: "select", required: true, options: YES_NO },
    { key: "previousStudentFinance", label: "Have you previously received student finance for any higher education course?", type: "select", required: true, options: YES_NO },
    { key: "previousFinanceDetails", label: "If Yes to above question, please provide details: Course Name, Institution, and Admission Year. Note: Full disclosure is mandatory. Previous study may affect your future student finance entitlement (Tuition and Maintenance Loans). Non-disclosure will result in the revocation of your admission. (If you said No to previous question, just put N/A)", type: "textarea", required: true, span: 2 },
    { key: "fundingIntent", label: "Please let us know how you intend to fund (£6185 per year)", type: "select", required: true, options: ["Student Loans Company", "Other"] },
    { key: "fundingOther", label: "If you have selected other, please specify; Otherwise enter N/A.", type: "text", required: true, span: 2 },
    { key: "employmentStatus", label: "What is your current employment status", type: "select", required: true, options: ["Employed", "Unemployed", "Self-Employed"] },
    { key: "employmentDetails", label: "If you are currently working, give details of your employment. (If you are not working put N/A)", type: "textarea", required: true, span: 2 },
    { key: "jobTitle", label: "Job title (If you are not working put N/A)", type: "text", required: true },
    { key: "companyName", label: "Company Name (If you are not working put N/A)", type: "text", required: true },
    { key: "dateStarted", label: "Date Started (If not working put N/A)", type: "text", required: true },
    { key: "workedPast", label: "Have you worked as employed or self employed person in past?", type: "select", required: true, options: YES_NO },
    { key: "workedPastDetails", label: "If you have been employed or self employed in past, (you may include voluntary work) give details here:", type: "textarea", span: 2 },
  ] },
  { title: "Reference 1", fields: [
    { key: "ref1Name", label: "Name", type: "text", required: true },
    { key: "ref1Contact", label: "Contact No", type: "tel", required: true },
    { key: "ref1Email", label: "Email", type: "email", required: true },
    { key: "ref1Relationship", label: "Relationship to you (Family, Friend, brother, sister, etc.)", type: "text", required: true, span: 2 },
  ] },
  { title: "Reference 2", fields: [
    { key: "ref2Name", label: "Name", type: "text", required: true },
    { key: "ref2Role", label: "Role", type: "text", required: true },
    { key: "ref2Organisation", label: "Institution/Organisation", type: "text", required: true },
    { key: "ref2Relationship", label: "Relationship to you (Manager, Supervisor, Colleague, owner)", type: "text", required: true, span: 2 },
  ] },
  { title: "EDI",
    note: "The data in the EDI section is being collected to meet legal/statutory duties and improve support to students. All data collected will be handled securely in line with GDPR.",
    fields: [
    { key: "ethnicity", label: "Ethnicity", type: "select", required: true, options: ["White British", "European", "White other", "Asian, British Asian", "Black, Black British", "Mixed", "Other", "Prefer not to say"] },
    { key: "religion", label: "Religion", type: "select", required: true, options: ["Christianity", "Hinduism", "Islam", "Buddhism", "Sikhism", "Judaism", "Other", "Prefer not to say"] },
  ] },
  { title: "Declaration",
    note: "I, the undersigned, hereby declare that the information provided in this application form is true and accurate to the best of my knowledge. I understand that any false or incorrect information may result in the rejection of my application for admission and/or the withdrawal of my registration at EdTech. Furthermore, I authorise EdTech to carry out any necessary checks to verify the information provided, including contacting previous employers, educational institutions, referees, and any other organisations listed in my application. I also confirm that I have been informed of and understand the following requirements of EdTech: (1) A minimum attendance of 85% is required. (2) If I have been referred by an agent, I confirm that all the above information has been clearly explained to me. (3) All assignments must be submitted by the stated deadlines in order to progress to the second year and successfully complete the course. By signing this application form, I confirm that I have read, understood, and agree to the above declaration.",
    fields: [
    { key: "signature", label: "Signature — write down your full name here", type: "text", required: true, span: 2 },
    { key: "declarationDate", label: "Date", type: "date", required: true },
  ] },
];
// The keys the form requires (asterisked in the original). Used to block save until filled.
export const ADMISSION_REQUIRED = ADMISSION_SECTIONS.flatMap(s => s.fields.filter(f => f.required).map(f => f.key));
