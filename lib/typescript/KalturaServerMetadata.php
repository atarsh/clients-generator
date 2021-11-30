<?php

function validateType($type, $typeClassName, $availableTypes, $target)
{

    $errors = array();

    if (!isset($type))
    {
        $errors[] = "missing type for {$target}";
    }else
    {
        switch ($type)
        {
            case KalturaServerTypes::Simple:
                $supportedTypes = array('int','bool','float','bigint','string');

                if (!in_array($typeClassName,$supportedTypes))
                {
                    $errors[] = "Unknown type '{$typeClassName}' for {$target}";

                }
                break;
            case KalturaServerTypes::Unknown:
                $errors[] = "Unknown type for {$target}";
                break;
            case KalturaServerTypes::Object:
            case KalturaServerTypes::ArrayOfObjects:
            case KalturaServerTypes::MapOfObjects:
            case KalturaServerTypes::EnumOfString:
            case KalturaServerTypes::EnumOfInt:
                if (!in_array($typeClassName, $availableTypes) && $typeClassName != "KalturaObjectBase")
                {
                    $errors[] = "Unknown type '{$typeClassName}' for {$target}";

                }
                break;
        }
    }

    return $errors;
}

class KalturaServerTypes
{
    const Unknown = "Unknown";
    const Simple = "Simple";
    const Object = "Object";
    const ArrayOfObjects = "ArrayOfObjects";
    const Void = "Void";
    const EnumOfInt = "EnumOfInt";
    const EnumOfString = "EnumOfString";
    const Date = "Date";
    const File = "File";
    const MapOfObjects = "Map";
}

class Service
{
    public $id;
    public $name;
    public $description;
    public $actions = array();

    public function prepare($availableTypes)
    {
        $errors = array();

        if (count($this->actions) == 0)
        {
            $errors[] = "Missing actions for service {$this->name}";
        }else {

            foreach ($this->actions as $action) {
                $errors = array_merge($errors, $action->prepare($availableTypes, $this));
            }
        }

        return $errors;
    }
}

class ServiceAction
{
    public $name;
    public $resultClassName;
    public $resultType;
    public $params = array();
    public $description;
    public $enableInMultiRequest = 1;

    public function prepare($availableTypes, $service)
    {
        $errors = array();

        $errors = array_merge(
            $errors,
            validateType($this->resultType,$this->resultClassName,$availableTypes,"service {$service->name} > action {$this->name} > result type")
        );



        foreach($this->params as $param)
        {
            $errors = array_merge($errors, $param->prepare($availableTypes, $service, $this));
        }

        return $errors;
    }
}

class ServiceActionParam
{
    public $name;
    public $typeClassName;
    public $type;
    public $optional = false;
    public $default;

    public function prepare($availableTypes, $service, $action)
    {
        $errors = array();

        if ($this->typeClassName == KalturaServerTypes::Void)
        {
            $errors[] = "service '{$service->name}' action '{$action->name}' param '{$this->name}' has invalid type void";
        }

        $errors = array_merge(
            $errors,
            validateType($this->type,$this->typeClassName,$availableTypes,"class {$service->name} > param {$this->name}")
        );


        if ($this->optional && (!isset($this->default)))
        {
            $errors[] = "Missing default value for service {$service->name} > action {$action->name} > param {$this->name}";
        }

        return $errors;
    }
}


class EnumValue
{
    public $name;
    public $value;

    function __construct($name, $value)
    {
        $this->name = $name;
        $this->value = $value;
    }
}

class EnumType
{
    public $name;
    public $type = null;
    public $values = array();

    public function prepare($availableTypes)
    {
        $errors = array();

        if ($this->type != "int" && $this->type != "string")
        {
            $errors[] = "Unknown type '{$this->type}' for enum {$this->name}";
        }

//        if (count($this->values) == 0)
//        {
//            $errors[] = "Missing values for enum {$this->name}";
//
//        }

        $processedValues = array();

        foreach($this->values as $item)
        {
            if (!isset($item->name) || !isset($item->value))
            {
                $errors[] = "Invalid enum value in enum {$this->name}";
            }else{
                if (in_array($item->name, $processedValues))
                {
                    $errors[] = "Duplicated items in enum {$this->name}";
                }
                $processedValues[] = $item->name;

                if (Utils::startsWithNumber($item->name))
                {
                    $errors[] = "Invalid enum value name '{$item->name}', starts with number. enum {$this->name}";
                }
            }
        }

        if (count($errors) == "0")
        {
            usort($this->values,function($a,$b)
            {
               return strcmp($a->name, $b->name);
            });
        }
        return $errors;
    }
}

class ClassType
{
    public $name;
    public $base = null;
    public $plugin = null;
    public $description = null;
    public $abstract = false;
    public $deprecated = false;
    public $properties = array();

    public function prepare(KalturaServerMetadata $serverMetadata, $availableTypes)
    {
        $errors = array();

        foreach($this->properties as $property)
        {
            $errors = array_merge($errors, $property->prepare($availableTypes,$this));
        }

        return $errors;
    }
}


class ClassTypeProperty
{
    public $name;
    public $description = null;
    public $typeClassName = null;
    public $type;
    public $writeOnly = false;
    public $readOnly = false;
    public $insertOnly = false;
    public $optional = true;
    public $default = 'null';

    public function prepare($availableTypes, $classType)
    {
        $errors = array();

        if ($this->typeClassName == KalturaServerTypes::Void)
        {
            $errors[] = "class '{$classType->name}' property '{$this->name}' has invalid type void";
        }


        $errors = array_merge(
            $errors,
            validateType($this->type,$this->typeClassName,$availableTypes,"class {$classType->name} > property {$this->name}")
        );

        if ($this->optional && (!isset($this->default)))
        {
            $errors[] = "Missing default value for class  {$classType->name}  > property {$this->name}";
        }

        return $errors;
    }
}

class KalturaServerMetadata
{
    public $apiVersion;
    public $services = array();
    public $classTypes = array();
    public $enumTypes = array();
    public $requestSharedParameters = array();

    public function prepare()
    {
        $errors = array();
        $availableTypes = array();

        foreach(array_merge($this->classTypes, $this->enumTypes) as $types)
        {
            $availableTypes[] = $types->name;
        }

        foreach($this->classTypes as $class)
        {
            $errors = array_merge($errors, $class->prepare($this, $availableTypes));
        }

        foreach($this->services as $service)
        {
            $errors = array_merge($errors, $service->prepare($availableTypes));
        }

        foreach($this->enumTypes as $enum)
        {
            $errors = array_merge($errors, $enum->prepare($availableTypes));
        }


        return $errors;
    }
}