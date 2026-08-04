# Workday careers (wd5) — live form research

Source tenant: `workday.wd5.myworkdayjobs.com`  
Job: Manager, Solution Consulting (oCIO) — Technology & Media (`JR-0109007`)  
Captured: 2026-08-03 (signed-in Apply Manually flow)

## Wizard (7 steps)

1. My Information  
2. My Experience  
3. Application Questions 1 of 2  
4. Application Questions 2 of 2  
5. Voluntary Disclosures  
6. Self Identify  
7. Review  

Progress DOM: `ol[data-automation-id="progressBar"]` with  
`progressBarActiveStep` / `progressBarInactiveStep` (text includes step name).

Continue: `button[data-automation-id="pageFooterNextButton"]` → “Save and Continue”.  
Never auto-click when label is Submit (Review).

## Auth gate

Apply → modal (Autofill with Resume / Apply Manually / Use My Last Application)  
→ Sign In (Apple / Google / email) before any form fields.  
Email on My Information is **display-only** from the account (not an input).

## My Information — field map (this tenant)

| UI label | Wrapper `data-automation-id` | Control |
|---|---|---|
| How Did You Hear About Us? | `formField-source` | `#source--source` input, `data-uxi-widget-type="selectinput"` (multiselect PromptSelect) |
| Previously worked / contractor? | `formField-candidateIsPreviousWorker` | radios `name="candidateIsPreviousWorker"` value `true`/`false` |
| Country / Territory | `formField-country` | `button#country--country` `aria-haspopup="listbox"` |
| Given Name(s) | `formField-legalName--firstName` | `#name--legalName--firstName` |
| Middle Name | `formField-legalName--middleName` | `#name--legalName--middleName` |
| Family Name | `formField-legalName--lastName` | `#name--legalName--lastName` |
| Local names | `formField-legalName--*Local` | optional text inputs |
| Preferred name | `formField-preferredCheck` | checkbox |
| Address Line 1 | `formField-addressLine1` | `#address--addressLine1` |
| City | `formField-city` | `#address--city` |
| Postal Code | `formField-postalCode` | `#address--postalCode` |
| Phone Device Type | `formField-phoneType` | `button#phoneNumber--phoneType` (default Mobile) |
| Country Phone Code | `formField-countryPhoneCode` | `#phoneNumber--countryPhoneCode` selectinput; selected chip `data-automation-id="selectedItem"` e.g. “India (+91)” |
| Phone Number | `formField-phoneNumber` | `#phoneNumber--phoneNumber` |
| Phone Extension | `formField-extension` | `#phoneNumber--extension` |

Page shell: `data-automation-id="applyFlowMyInfoPage"` inside `applyFlowPage`.

**No state/province field** when Country = India on this tenant.

## Widget model (`data-uxi-widget-type`)

- `multiselect` — container (`multiSelectContainer`)
- `selectinput` — searchable input (`#source--source`, `#phoneNumber--countryPhoneCode`)
- `selectinputlist` / `selectinputlistitem` — selected chips
- `prompt` / `multiselectlist` / `multiselectlistitem` — popup options portal
- Options: `[data-automation-id="menuItem"][role="option"]` + child `[data-automation-id="promptOption"]` with `data-automation-label`
- Selected chip: `[data-automation-id="selectedItem"]`
- Search in open prompt: `[data-automation-id="searchBox"]`

### Source hierarchy note

Typing “LinkedIn” surfaces **categories**, not LinkedIn itself:  
Advertisement, Partnership, Socially, Website, Workday.  
LinkedIn is likely under **Socially** (drill-in). Adapter should try leaf “LinkedIn”, then parent “Socially”.

### Country / phone type

Plain `button[aria-haspopup="listbox"]` (not selectinput). Value is an opaque GUID; visible label is button text (“India”, “Mobile”).

## Legacy vs modern IDs

Older docs / other tenants used:

- `legalNameSection_firstName`, `phone-number`, `addressSection_*`, `bottom-navigation-next-button`

This wd5 careers UI uses:

- `formField-*` wrappers + `#section--field` input ids + `pageFooterNextButton`

Tvarin’s Workday adapter keeps **both** schemes.

## Still to capture

- Application Questions 1 & 2  
- Voluntary Disclosures + Self Identify option labels  

## My Experience (`applyFlowMyExpPage`) — step 2 of 7

Sections (each starts collapsed except Skills + Resume):

| Section | Add control | Notes |
|---|---|---|
| Work Experience | `button[data-automation-id="add-button"]` under `#Work-Experience-section` → becomes “Add Another” | Repeating panels `workExperience-{n}--*` |
| Education | Add under `#Education-section` | Panels `education-{n}--*` |
| Certifications | Add under `#Certifications-section` | Panels `certification-{n}--*` |
| Skills | always visible | `#skills--skills` selectinput / `formField-skills` |
| Resume/CV | always visible | `input[data-automation-id="file-upload-input-ref"]`, button `select-files`, drop zone `file-upload-drop-zone`, wrapper `attachments-FileUpload` |
| Websites | Add under `#Websites-section` | Panels `webAddress-{n}--url` / `formField-url` |

Also: `pageFooterBackButton` (“Back”), `progressBarCompletedStep` for finished steps.

### Work Experience panel (after Add)

| UI | Wrapper | Control |
|---|---|---|
| Job Title* | `formField-jobTitle` | `#workExperience-{n}--jobTitle` `name=jobTitle` |
| Company* | `formField-companyName` | `#workExperience-{n}--companyName` |
| Location | `formField-location` | `#workExperience-{n}--location` |
| I currently work here | `formField-currentlyWorkHere` | checkbox `#workExperience-{n}--currentlyWorkHere` |
| From* | `formField-startDate` | MM/YYYY via `dateSectionMonth-input` + `dateSectionYear-input` |
| To* | `formField-endDate` | same date widgets |
| Role Description | `formField-roleDescription` | textarea `#workExperience-{n}--roleDescription` |
| Delete | button text “Delete” | removes panel |

### Education panel

| UI | Wrapper | Control |
|---|---|---|
| School or University* | `formField-school` | `#education-{n}--school` selectinput |
| Degree* | `formField-degree` | `button#education-{n}--degree` listbox (“Select One”) |
| Field of Study | `formField-fieldOfStudy` | `#education-{n}--fieldOfStudy` selectinput |

### Certifications panel

| UI | Wrapper | Control |
|---|---|---|
| Certification* | `formField-certification` | `#certification-{n}--certification` selectinput |
| Certification Number | `formField-certificationNumber` | text input |
| Issued Date | `formField-issuedDate` | MM/DD/YYYY (`dateSectionMonth/Day/Year-input`) |
| Expiration Date | `formField-expirationDate` | MM/DD/YYYY |
| Attachments | `formField-` + file upload | another `file-upload-input-ref` |

### Websites panel

| UI | Wrapper | Control |
|---|---|---|
| URL* | `formField-url` | `#webAddress-{n}--url` `name=url` |

### Adapter implications

- **Do not click Add** for Work/Education/Cert unless the profile has structured rows — empty required panels block Continue.  
- Default Experience fill: attach resume (`file-upload-input-ref`) + skills chips + website URLs (LinkedIn / GitHub / portfolio) via Add + `#webAddress-*--url`.  
- Role description can take `profile.experience` text **only if** a work panel already exists.  
- Date widgets are split month/year (or month/day/year) inputs with `data-automation-id="dateSectionMonth-input"` etc., not a single ISO field.
