{{/*
Expand the name of the chart.
*/}}
{{- define "postimap.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "postimap.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "postimap.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "postimap.labels" -}}
helm.sh/chart: {{ include "postimap.chart" . }}
{{ include "postimap.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "postimap.selectorLabels" -}}
app.kubernetes.io/name: {{ include "postimap.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the ServiceAccount to use.
*/}}
{{- define "postimap.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "postimap.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret to reference for DB_PASSWORD / ENCRYPTION_KEY.
*/}}
{{- define "postimap.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- include "postimap.fullname" . }}
{{- end }}
{{- end }}

{{/*
Image tag, falling back to the chart's appVersion.
*/}}
{{- define "postimap.imageTag" -}}
{{- default .Chart.AppVersion .Values.image.tag }}
{{- end }}

{{/*
Port the application actually listens on.

`config.health.port` is the value the app reads, so it wins when set. The
Service port stays independent: it is what clients connect to, and defaults to
the same number only for convenience.
*/}}
{{- define "postimap.healthPort" -}}
{{- dig "health" "port" .Values.service.port .Values.config }}
{{- end }}
