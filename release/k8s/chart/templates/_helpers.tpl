{{- define "atlas-system-tester.name" -}}
{{- .Values.appKey | default .Chart.Name -}}
{{- end -}}

{{- define "atlas-system-tester.labels" -}}
app.kubernetes.io/name: {{ include "atlas-system-tester.name" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}
